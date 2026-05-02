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
    error NotVaultOf();
    error AlreadyFunded();
    error NotFinalized();
    error NotUnlocked();
    error AlreadyClaimed();
    error InvalidProof();

    constructor(address launcher_, address weth_, address oracle_) {
        launcher = launcher_;
        weth = weth_;
        oracle = oracle_;
    }

    function bonusOf(uint256 seasonId) external view returns (SeasonBonus memory) {
        return _bonuses[seasonId];
    }

    /// @notice Vault calls this during `SeasonVault.finalize`. Pulls `amount` WETH.
    /// @dev    `nonReentrant` per spec §42.2.5 -- a malicious vault could otherwise re-enter
    ///         via the WETH transferFrom hook to fund a different seasonId mid-call.
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

    /// @notice Oracle posts the eligibility Merkle root after the hold window concludes.
    /// @dev    `nonReentrant` per spec §42.2.5 -- defense-in-depth. postRoot has no in-call
    ///         external callback today, but the guard prevents a future maintainer from
    ///         reordering operations into a vulnerable state.
    function postRoot(uint256 seasonId, bytes32 root) external nonReentrant {
        if (msg.sender != oracle) revert NotOracle();
        SeasonBonus storage b = _bonuses[seasonId];
        if (b.vault == address(0)) revert AlreadyFunded(); // i.e. not funded
        if (block.timestamp < b.unlockTime) revert NotUnlocked();
        b.root = root;
        b.finalized = true;
        emit BonusRootPosted(seasonId, root);
    }

    /// @notice Claim the precomputed bonus amount for `msg.sender`.
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

    function setOracle(address newOracle) external {
        if (msg.sender != launcher) revert NotOracle();
        oracle = newOracle;
    }
}
