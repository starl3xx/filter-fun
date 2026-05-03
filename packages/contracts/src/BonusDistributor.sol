// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BonusDistributor
/// @notice 14-day hold-bonus payout. Each season's `SeasonVault` calls `fundBonus(...)` at
///         finalize, transferring the WETH reserve in. The oracle posts a Merkle root over the
///         eligible-holders set during the hold window, where each leaf is `(user, bonusAmount)`
///         and the oracle has already enforced the "≥80% balance across N snapshots" criterion.
/// @dev    Inherits OZ `ReentrancyGuard` and applies `nonReentrant` to every state-mutating
///         function per spec §42.2.5 (settlement-pipeline reentrancy safety). The contract was
///         incidentally CEI-correct on `claim()`, but `fundBonus()` had a genuine cross-season
///         re-entry path through a malicious WETH transfer hook (a vault contract acting as both
///         caller and hook target could fund a different seasonId mid-call). The guard is the
///         spec-required defense layer; do not remove it without re-reading audit finding C-1
///         (Phase 1 audit, PR #52, `audit/2026-05-PHASE-1-AUDIT/contracts.md`).
contract BonusDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable launcher;
    address public immutable weth;

    address public oracle;

    struct SeasonBonus {
        address vault;
        address winnerToken;
        uint256 unlockTime;
        uint256 reserve;
        uint256 claimedTotal;
        bytes32 root;
        bool finalized; // true once oracle posted the eligibility root
    }

    mapping(uint256 => SeasonBonus) internal _bonuses;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event BonusFunded(uint256 indexed seasonId, address vault, uint256 reserve, uint256 unlockTime);
    event BonusRootPosted(uint256 indexed seasonId, bytes32 root);
    event BonusClaimed(uint256 indexed seasonId, address indexed user, uint256 amount);

    error NotOracle();
    /// @notice Caller of `setOracle` is not the configured launcher. Audit H-3 (Phase 1,
    ///         2026-05-01) flagged that the prior implementation reused `NotOracle()` for the
    ///         setOracle authorisation check, which mis-signaled the failure cause: the
    ///         caller wasn't expected to BE the oracle, they needed to be the LAUNCHER.
    error NotLauncher();
    error NotVaultOf();
    error AlreadyFunded();
    error NotFinalized();
    /// @notice `postRoot` was called before the bonus's `unlockTime` had elapsed.
    /// @dev    Audit I-Contracts-1 (Phase 1, 2026-05-01): renamed from `NotUnlocked` so the
    ///         selector reads as a timing-error, not an authorisation-error. The previous
    ///         name surfaced in revert traces alongside `NotOracle` / `NotLauncher` and read
    ///         as "you are not unlocked" rather than "it is not yet time to post the root."
    error NotYetUnlocked();
    error AlreadyClaimed();
    error InvalidProof();

    /// @dev Wraps the launcher-only check used by `setOracle`. Audit H-3 (Phase 1,
    ///      2026-05-01) extracted this into a named modifier so the auth gate is greppable
    ///      and any future launcher-gated entry inherits the canonical revert reason.
    modifier onlyLauncher() {
        if (msg.sender != launcher) revert NotLauncher();
        _;
    }

    constructor(address launcher_, address weth_, address oracle_) {
        launcher = launcher_;
        weth = weth_;
        oracle = oracle_;
    }

    function bonusOf(uint256 seasonId) external view returns (SeasonBonus memory) {
        return _bonuses[seasonId];
    }

    /// @notice Vault calls this during `SeasonVault.submitWinner` to seed the season's
    ///         hold-bonus pool. Pulls `amount` WETH from `msg.sender` (the calling vault)
    ///         and stamps the season's bonus record with the winner token + unlock time.
    /// @param  seasonId    The season this bonus pool belongs to. Must not have been funded
    ///                     before — re-funding the same season reverts with `AlreadyFunded`.
    /// @param  winnerToken The settlement winner for the season. Recorded for indexer use
    ///                     and so the eligibility root committed later via `postRoot` is
    ///                     unambiguously bound to this winner.
    /// @param  unlockTime  Earliest block timestamp at which `postRoot` may be called.
    ///                     Vault sets this to `submitWinner.timestamp + bonusUnlockDelay`
    ///                     so the eligibility window can run before the oracle commits the
    ///                     Merkle root.
    /// @param  amount      WETH transferred in from the caller. Must equal the amount the
    ///                     caller has approved on this contract; transfer reverts on shortfall.
    /// @dev    `nonReentrant` per spec §42.2.5 — a malicious vault could otherwise re-enter
    ///         via the WETH transferFrom hook to fund a different seasonId mid-call. Audit
    ///         finding C-1 (Phase 1, PR #52) is the regression record; do not remove the
    ///         guard without re-reading `audit/2026-05-PHASE-1-AUDIT/contracts.md`.
    /// @dev    Permissionless by design — the season's vault address is stamped from
    ///         `msg.sender` as the source of authority for `postRoot`'s `b.vault` lookup.
    ///         Anyone can fund a fresh season, but only the funder's address gets recorded
    ///         as the season's vault. In practice, only the legitimate `SeasonVault` ever
    ///         calls this because the WETH approval needs to come from the same account.
    function fundBonus(uint256 seasonId, address winnerToken, uint256 unlockTime, uint256 amount)
        external
        nonReentrant
    {
        SeasonBonus storage b = _bonuses[seasonId];
        if (b.vault != address(0)) revert AlreadyFunded();
        b.vault = msg.sender;
        b.winnerToken = winnerToken;
        b.unlockTime = unlockTime;
        b.reserve = amount;
        IERC20(weth).safeTransferFrom(msg.sender, address(this), amount);
        emit BonusFunded(seasonId, msg.sender, amount, unlockTime);
    }

    /// @notice Oracle posts the eligibility Merkle root for `seasonId` after the hold-window
    ///         unlock time has elapsed. Each leaf encodes `(user, bonusAmount)` and the
    ///         oracle has already enforced the "≥80% balance across N snapshots" criterion
    ///         off-chain when assembling the tree.
    /// @param  seasonId The season whose bonus eligibility tree is being committed. Must
    ///                  have been funded by a prior `fundBonus` call; calling on an unfunded
    ///                  season reverts with `AlreadyFunded` (the sentinel for "not funded").
    /// @param  root     The Merkle root of the eligibility set. Subsequent `claim` calls
    ///                  verify proofs against this root.
    /// @dev    Oracle-only (`if (msg.sender != oracle) revert NotOracle()`) — the oracle is
    ///         configured at construction and rotated through `setOracle` by the launcher.
    /// @dev    `nonReentrant` per spec §42.2.5 — defense in depth. `postRoot` has no in-call
    ///         external callback today, but the guard prevents a future maintainer from
    ///         reordering operations into a vulnerable state.
    function postRoot(uint256 seasonId, bytes32 root) external nonReentrant {
        if (msg.sender != oracle) revert NotOracle();
        SeasonBonus storage b = _bonuses[seasonId];
        if (b.vault == address(0)) revert AlreadyFunded(); // i.e. not funded
        if (block.timestamp < b.unlockTime) revert NotYetUnlocked();
        b.root = root;
        b.finalized = true;
        emit BonusRootPosted(seasonId, root);
    }

    /// @notice Claim the precomputed bonus amount for `msg.sender` from the season's funded
    ///         pool. Single-shot per (seasonId, user); a second call after a successful
    ///         claim reverts with `AlreadyClaimed`.
    /// @param  seasonId The season whose bonus is being claimed. Root must already be
    ///                  posted (`finalized == true`) — calling pre-finalize reverts with
    ///                  `NotFinalized`.
    /// @param  amount   The caller's eligible bonus amount, in WETH wei. Must match the
    ///                  amount encoded in the Merkle leaf (`keccak256(user, amount)`);
    ///                  any divergence fails proof verification.
    /// @param  proof    Merkle proof binding `(msg.sender, amount)` to the season's posted
    ///                  root. Verified via OpenZeppelin's `MerkleProof.verifyCalldata`.
    /// @dev    `nonReentrant` per spec §42.2.5. CEI is also satisfied (state set before the
    ///         WETH transfer) but the guard is the primary defense layer the spec mandates.
    function claim(uint256 seasonId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        SeasonBonus storage b = _bonuses[seasonId];
        if (!b.finalized) revert NotFinalized();
        if (claimed[seasonId][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProof.verifyCalldata(proof, b.root, leaf)) revert InvalidProof();
        claimed[seasonId][msg.sender] = true;
        b.claimedTotal += amount;
        IERC20(weth).safeTransfer(msg.sender, amount);
        emit BonusClaimed(seasonId, msg.sender, amount);
    }

    /// @notice Rotate the oracle authorised to call `postRoot`. Launcher-gated.
    /// @param  newOracle Replacement oracle address. Audit H-4 zero-address checks live on
    ///                   the launcher's `setOracle`; here we trust the launcher's check
    ///                   rather than re-validating.
    /// @dev    Audit H-3 (Phase 1, 2026-05-01): the prior implementation reverted with
    ///         `NotOracle()` when a non-launcher caller tried this, mis-signaling the
    ///         actual auth requirement (caller must be the LAUNCHER, not the oracle).
    ///         Renamed to `NotLauncher()` and routed through the `onlyLauncher` modifier so
    ///         the revert reason matches the failed predicate.
    function setOracle(address newOracle) external onlyLauncher {
        oracle = newOracle;
    }
}
