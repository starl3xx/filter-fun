// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {
    SeasonVault,
    IBonusFunding,
    IPOLManager,
    ICreatorRegistry,
    ICreatorFeeDistributor,
    ITournamentRegistry
} from "../../../src/SeasonVault.sol";
import {BonusDistributor} from "../../../src/BonusDistributor.sol";

import {MockWETH} from "../../mocks/MockWETH.sol";
import {MintableERC20} from "../../mocks/MintableERC20.sol";
import {MaliciousERC20} from "../MaliciousReceiver.sol";
import {MockLpLocker} from "../../mocks/MockLpLocker.sol";
import {MockLauncherView} from "../../mocks/MockLauncherView.sol";
import {MockPOLManager} from "../../mocks/MockPOLManager.sol";
import {MockCreatorRegistry} from "../../mocks/MockCreatorRegistry.sol";
import {MockCreatorFeeDistributor} from "../../mocks/MockCreatorFeeDistributor.sol";
import {MockTournamentRegistry} from "../../mocks/MockTournamentRegistry.sol";

import {MaliciousReceiver} from "../MaliciousReceiver.sol";

/// @title SettlementHandler
/// @notice Bounded-action fuzz handler for the weekly settlement pipeline (SeasonVault +
///         BonusDistributor + POLManager wiring). Exposes a fixed set of state-mutating entry
///         points for the Foundry fuzzer to sequence randomly; tracks ghost variables that the
///         top-level invariant suite reads.
///
///         The handler owns the entire deployed cohort (vault, mocks, lockers, ERC20s, oracle
///         identity) so each invariant test starts from a known constructor state and the
///         fuzzer's selectors mutate that single cohort.
///
///         Action bounding follows Foundry conventions:
///           - Every numeric input is `bound(...)`-ed into a productive range so the fuzzer
///             doesn't waste cycles on revert-everything inputs.
///           - Wrong-phase calls are no-ops (fuzzer treats reverts as harmless skips).
///           - Adversary actions deliberately attempt revert paths; if the call somehow
///             succeeds the handler trips a ghost flag the invariant suite asserts on.
///
///         The cohort is deliberately small (1 winner, 5 losers, 5 holders) so the fuzzer
///         can densely cover every (action × actor × token) combination within
///         `runs × depth` steps.
contract SettlementHandler is Test {
    // ============================================================ Cohort

    uint256 public constant SEASON_ID = 1;
    uint256 public constant LOSER_COUNT = 5;
    /// @dev Power of 2 — keeps the Merkle tree perfectly pairwise so `_buildRoot` /
    ///      `_proofForHolder` never hit the odd-out edge case (where a leaf would be
    ///      promoted unhashed but OZ's verifier always hashes pairs, producing
    ///      `H(L,L) ≠ L` and silently failing every claim).
    uint256 public constant HOLDER_COUNT = 4;
    /// @dev Mint rate used by both winner-locker and POLManager so all winner-token math
    ///      is deterministic across fuzz sequences. 100_000 winner tokens per 1 WETH (18d).
    uint256 internal constant MINT_RATE = 100_000e18;
    /// @dev Bound on per-event proceeds. Upper bound chosen so cumulative proceeds across a
    ///      run stay well under uint128 max — keeps every BPS multiplication safe and lets
    ///      the fuzzer hit dust regions (1, 999, prime) without trivially overflowing.
    uint256 internal constant MAX_PROCEEDS_PER_EVENT = 1000 ether;
    /// @dev Fixed bonus-unlock delay used at vault construction. Mirrors weekly cadence so
    ///      block.timestamp manipulation in fuzz runs maps to the real-protocol window.
    uint256 internal constant BONUS_UNLOCK_DELAY = 14 days;

    SeasonVault public vault;
    BonusDistributor public bonus;
    MockWETH public weth;
    MockLauncherView public launcher;
    MockPOLManager public polManager;
    MockCreatorRegistry public creatorRegistry;
    MockCreatorFeeDistributor public creatorFeeDistributor;
    MockTournamentRegistry public tournamentRegistry;

    address public oracle;
    address public treasury;
    address public mechanics;
    address public winnerCreator;
    address public adversary;

    address public winnerToken;
    MockLpLocker public winnerLocker;
    address[LOSER_COUNT] public losers;
    MockLpLocker[LOSER_COUNT] public loserLockers;

    address[HOLDER_COUNT] public holders;
    /// @notice Per-holder rollover share. Picked at construction time so the Merkle leaves
    ///         and total share are known up-front; the handler builds the root once at
    ///         `submitWinner` time.
    uint256[HOLDER_COUNT] public holderShares;

    /// @notice Reentrancy harness; one of the holders is wired to this attacker so its
    ///         `claimRollover` call goes through the malicious receiver.
    MaliciousReceiver public attacker;
    uint256 public attackerHolderIdx;

    // ============================================================ Bonus-claim re-entry harness
    //
    // Audit Finding C-1 (PR #52) closed the BonusDistributor reentrancy gap. The
    // production-flow `bonus` instance is wired to the regular `weth` (no transfer hook), so
    // the standard fuzz cycle can't actually fire a transfer-hook re-entry against it. The
    // harness below deploys a SECOND BonusDistributor instance backed by a `MaliciousERC20`
    // bonus-WETH so the attacker's transfer hook fires inside `claim()`. The new invariant
    // (`invariant_bonusDistributor_reentrancySafe`) asserts that across every fuzz run the
    // attacker's inner re-entry is blocked AND the bonus accounting stays consistent.

    MaliciousERC20 public bonusReentryWeth;
    BonusDistributor public bonusReentry;
    /// @notice Synthetic seasonId for the re-entry harness; isolated from the production-flow
    ///         `bonus` instance which uses `SEASON_ID = 1`.
    uint256 public constant BONUS_REENTRY_SEASON = 9999;
    /// @notice Total reserve funded into the harness distributor. Two equal claims of
    ///         `BONUS_REENTRY_AMOUNT / 2` are eligible (attacker + a benign normal user).
    uint256 public constant BONUS_REENTRY_RESERVE = 0.5 ether;
    address public bonusReentryFunder;
    address public bonusReentryNormalUser;
    /// @notice Pre-built proof for the attacker's leaf (size-2 tree, sibling is the normal
    ///         user's leaf).
    bytes32 internal _bonusReentryAttackerProof;
    bool public ghostBonusReentryAttempted;
    bool public ghostBonusReentryBypassed;
    // Note: the "which defense layer fired" check (CEI vs OZ ReentrancyGuard) lives in the
    // deterministic exploit-reproduction at test/security/BonusDistributorReentrancy.t.sol,
    // which inspects the inner call's revert selector directly. The fuzz invariant here only
    // asserts the broader bypass-never-succeeds property; capturing per-call revert data
    // through MaliciousReceiver would require extending the shared harness for marginal value.

    // ============================================================ Ghost variables
    //
    // Updated only by handler entry points. The invariant suite reads these to verify the
    // contracts under test stay consistent with the bounded action sequence.

    /// @notice Sum of every WETH proceed value the handler fed into a successful
    ///         processFilterEvent. Conservation invariant compares this against the sum of
    ///         all six destination accruals.
    uint256 public ghostTotalProceeds;
    /// @notice Filter events ever attempted (success or no-op). For sanity / fuzz-coverage
    ///         debugging.
    uint256 public ghostFilterEventCalls;
    /// @notice Successful filter events (proceeds > 0). The on-chain `filterEventCount`
    ///         covers all events including zero-proceeds; this ghost focuses on accruing ones.
    uint256 public ghostNonZeroFilterEvents;
    /// @notice Cumulative bounty slices observed at filter-event time.
    uint256 public ghostBountyAccrued;
    uint256 public ghostRolloverAccrued;
    uint256 public ghostBonusAccrued;
    uint256 public ghostMechanicsAccrued;
    uint256 public ghostPolAccrued;
    /// @notice Treasury accrual *from filter events only* — does NOT include the residue sweep
    ///         done at `submitWinner`. Conservation math separates these two streams: the
    ///         user-aligned split must hold per-event before the residue sweep happens.
    uint256 public ghostTreasuryAccruedFromEvents;

    /// @notice Set true when the handler wraps a `submitWinner` call and clears it at exit.
    ///         The MockPOLManager's `lastSender` is checked against this so the invariant
    ///         suite can prove POL deployment NEVER happens outside the finalize call.
    bool public ghostInsideSubmitWinner;
    /// @notice Increments inside submitWinner when polManager.deployPOL fired. Should be 0 or 1
    ///         across the run (single-season cohort).
    uint256 public ghostPolDeployCount;
    /// @notice Snapshot of `polManager.callCount()` taken before submitWinner. The
    ///         no-mid-season-deployment invariant asserts the manager's callCount is unchanged
    ///         between submitWinner calls.
    uint256 public ghostPolCallCountAtPhaseEntry;

    /// @notice Tracks whether the oracle (or anyone else) ever managed to publish a Merkle
    ///         root more than once. Set by the adversarial republish handler; the merkle-root
    ///         immutability invariant asserts this stays false.
    bool public ghostMerkleRepublished;
    /// @notice Tracks whether a non-oracle actor ever managed to invoke a privileged
    ///         function without reverting. Set by the imposter handlers; the oracle-authority
    ///         invariant asserts this stays false.
    bool public ghostAuthBypass;
    /// @notice Tracks whether a re-entrant call into a `nonReentrant` function ever
    ///         returned success. Set by the reentrant-claim handler; the reentrancy-safety
    ///         invariant asserts this stays false.
    bool public ghostReentrancyBypass;
    /// @notice True once the reentrant-claim handler has fired the malicious token's
    ///         transfer hook at least once. Lets the invariant assert that the reentry
    ///         path was actually exercised (vs. silently bypassed because of a broken
    ///         proof or mis-wired token), giving the safety check teeth.
    bool public ghostReentryAttemptedAtLeastOnce;
    /// @notice True once submitWinner has succeeded. Gates handlers that only make sense
    ///         post-finalize (claim*, etc).
    bool public ghostWinnerSubmitted;

    // ============================================================ Audit H-2 — oracle rotation
    //
    // Audit H-2 (Phase 1, 2026-05-01) regression cover. SeasonVault.onlyOracle now reads
    // `launcher.oracle()` live; every rotation on the launcher must take effect immediately
    // on every existing per-season vault. This harness rotates the launcher's oracle to a
    // fresh address, remembers the previous one, then probes BOTH endpoints:
    //   - the previous oracle attempting `processFilterEvent` MUST revert
    //   - the new oracle attempting `processFilterEvent` MUST succeed (or no-op-revert with
    //     a non-auth reason like AlreadyLiquidated, but NOT NotOracle)
    //
    // The invariant `invariant_oracleAuthorityCurrent` reads these ghosts to assert the
    // post-rotation state is sound. Without this harness an H-2-style regression (storing
    // oracle on the vault again) would silently re-introduce the staleness.

    /// @notice Number of times the handler has rotated `launcher.oracle()` to a fresh address.
    uint256 public ghostOracleRotations;
    /// @notice Most-recent prior oracle (the one that was just rotated AWAY from). Probes
    ///         use this address to confirm it loses authority.
    address public ghostPrevOracle;
    /// @notice True once a probe with the prev-oracle has reverted with NotOracle. The
    ///         currency invariant requires this to be true if any rotation has happened —
    ///         otherwise we'd be running a "rotation regression cover" that never actually
    ///         exercises the rejection path.
    bool public ghostPrevOracleRejectedAtLeastOnce;

    // ============================================================ Construction

    constructor() {
        oracle = makeAddr("settlement.oracle");
        treasury = makeAddr("settlement.treasury");
        mechanics = makeAddr("settlement.mechanics");
        winnerCreator = makeAddr("settlement.winnerCreator");
        adversary = makeAddr("settlement.adversary");

        weth = new MockWETH();
        launcher = new MockLauncherView();
        // Live-read oracle: SeasonVault.onlyOracle reads `launcher.oracle()` per audit H-2.
        // Wire it BEFORE constructing the vault so the bounded-action sequence has a valid
        // oracle on day zero.
        launcher.setOracle(oracle);
        bonus = new BonusDistributor(address(launcher), address(weth), oracle);
        polManager = new MockPOLManager(IERC20(address(weth)));
        polManager.setMintRate(MINT_RATE);
        polManager.setLiquidityReturn(uint128(0xDEADBEEF));
        creatorRegistry = new MockCreatorRegistry();
        creatorFeeDistributor = new MockCreatorFeeDistributor();
        tournamentRegistry = new MockTournamentRegistry();

        vault = new SeasonVault(
            address(launcher),
            SEASON_ID,
            address(weth),
            treasury,
            mechanics,
            IPOLManager(address(polManager)),
            IBonusFunding(address(bonus)),
            BONUS_UNLOCK_DELAY,
            ICreatorRegistry(address(creatorRegistry)),
            ICreatorFeeDistributor(address(creatorFeeDistributor)),
            ITournamentRegistry(address(tournamentRegistry))
        );
        launcher.setVault(SEASON_ID, address(vault));

        // Tokens + lockers. Winner is a `MaliciousERC20` (transfer-hook-capable) so
        // `claimRollover`'s `IERC20(winner).safeTransfer(...)` actually fires the hook
        // configured by `fuzz_reentrantClaim`. The hook target stays `address(0)` until
        // the attacker is constructed below — every other call path (mint during
        // submitWinner, transfer during honest claims) sees `hookTarget == 0` and runs
        // the standard ERC20 path with no callback.
        MaliciousERC20 winner = new MaliciousERC20("Winner", "WIN");
        winnerToken = address(winner);
        winnerLocker = new MockLpLocker(winnerToken, address(weth), address(vault));
        winnerLocker.setMintRate(MINT_RATE);
        launcher.setLocker(SEASON_ID, winnerToken, address(winnerLocker));
        creatorRegistry.set(winnerToken, winnerCreator);

        for (uint256 i = 0; i < LOSER_COUNT; ++i) {
            address t = address(
                new MintableERC20(
                    string(abi.encodePacked("Loser", _toAscii(i))), string(abi.encodePacked("L", _toAscii(i)))
                )
            );
            losers[i] = t;
            MockLpLocker locker = new MockLpLocker(t, address(weth), address(vault));
            loserLockers[i] = locker;
            launcher.setLocker(SEASON_ID, t, address(locker));
        }

        // Holders. Shares chosen so totalShares is non-trivial across the cohort and the
        // Merkle root has a single distinct leaf per holder. HOLDER_COUNT=4 keeps the tree
        // perfectly pairwise (no odd-out leaves).
        holderShares[0] = 100;
        holderShares[1] = 75;
        holderShares[2] = 50;
        holderShares[3] = 25;
        for (uint256 i = 0; i < HOLDER_COUNT; ++i) {
            holders[i] = makeAddr(string(abi.encodePacked("settlement.holder.", _toAscii(i))));
        }

        // Wire the attacker as the LAST holder so the rollover claim path naturally hands
        // tokens to a contract address. The malicious winner's transfer hook is set to fire
        // into this attacker — armed only inside `fuzz_reentrantClaim`, so honest claims
        // and the submitWinner mint paths see `armed == false` and run as no-ops.
        attacker = new MaliciousReceiver();
        attackerHolderIdx = HOLDER_COUNT - 1;
        holders[attackerHolderIdx] = address(attacker);
        winner.setHook(address(attacker));

        // ====== Bonus-claim re-entry harness (Audit C-1 regression cover)
        //
        // Separate BonusDistributor instance backed by a MaliciousERC20 bonus-WETH so the
        // attacker's transfer hook fires inside `claim()` (the production `bonus` uses the
        // standard MockWETH which has no hook). One funder, two eligible claimants
        // (attacker + a benign normal user) so the Merkle root is non-trivial.
        bonusReentryWeth = new MaliciousERC20("BonusWETH", "bWETH");
        bonusReentry = new BonusDistributor(address(launcher), address(bonusReentryWeth), oracle);
        bonusReentryWeth.setHook(address(attacker));
        bonusReentryFunder = makeAddr("bonusReentry.funder");
        bonusReentryNormalUser = makeAddr("bonusReentry.normal");

        // Fund. Mint + approve from `bonusReentryFunder`, call `fundBonus`. The hook will
        // fire on the transferFrom but `armed == false` here so it's a no-op.
        bonusReentryWeth.mint(bonusReentryFunder, BONUS_REENTRY_RESERVE);
        vm.prank(bonusReentryFunder);
        bonusReentryWeth.approve(address(bonusReentry), BONUS_REENTRY_RESERVE);
        vm.prank(bonusReentryFunder);
        bonusReentry.fundBonus(
            BONUS_REENTRY_SEASON, address(0xDEAD), block.timestamp + 1, BONUS_REENTRY_RESERVE
        );

        // Build the size-2 Merkle root: attacker + normal user, each entitled to half.
        bytes32 leafA = keccak256(abi.encodePacked(address(attacker), BONUS_REENTRY_RESERVE / 2));
        bytes32 leafN = keccak256(abi.encodePacked(bonusReentryNormalUser, BONUS_REENTRY_RESERVE / 2));
        bytes32 root = leafA < leafN
            ? keccak256(abi.encodePacked(leafA, leafN))
            : keccak256(abi.encodePacked(leafN, leafA));
        _bonusReentryAttackerProof = leafN;

        // Warp past unlock and post the root.
        vm.warp(block.timestamp + 2);
        vm.prank(oracle);
        bonusReentry.postRoot(BONUS_REENTRY_SEASON, root);
    }

    // ============================================================ Helpers

    function _toAscii(uint256 i) internal pure returns (bytes memory) {
        bytes memory b = new bytes(1);
        b[0] = bytes1(uint8(48 + (i % 10)));
        return b;
    }

    /// @dev Finds the lowest-indexed loser that hasn't been liquidated yet. Returns
    ///      `LOSER_COUNT` if all are spent.
    function _firstUnliquidatedLoser(uint256 startSeed) internal view returns (uint256) {
        uint256 start = startSeed % LOSER_COUNT;
        for (uint256 step = 0; step < LOSER_COUNT; ++step) {
            uint256 idx = (start + step) % LOSER_COUNT;
            if (!vault.liquidated(losers[idx])) return idx;
        }
        return LOSER_COUNT;
    }

    /// @dev Build the Merkle root over (holder, share) leaves for the cohort. The same root
    ///      shape is built at every successful submitWinner. Holders use the canonical
    ///      `keccak256(abi.encodePacked(user, share))` leaf form per the vault's claim path.
    function _rolloverRoot() internal view returns (bytes32 root, uint256 totalShares) {
        bytes32[] memory leaves = new bytes32[](HOLDER_COUNT);
        for (uint256 i = 0; i < HOLDER_COUNT; ++i) {
            totalShares += holderShares[i];
            leaves[i] = keccak256(abi.encodePacked(holders[i], holderShares[i]));
        }
        root = _buildRoot(leaves);
    }

    /// @dev Pairwise-sorted Merkle root construction matching `MerkleProof.verifyCalldata`.
    function _buildRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        while (n > 1) {
            uint256 next = (n + 1) / 2;
            for (uint256 i = 0; i < next; ++i) {
                if (2 * i + 1 < n) {
                    bytes32 a = leaves[2 * i];
                    bytes32 b = leaves[2 * i + 1];
                    leaves[i] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
                } else {
                    leaves[i] = leaves[2 * i];
                }
            }
            n = next;
        }
        return leaves[0];
    }

    /// @dev Build a Merkle proof for leaf at index `target` in a HOLDER_COUNT-sized leaf set.
    function _proofForHolder(uint256 target) internal view returns (bytes32[] memory proof) {
        bytes32[] memory layer = new bytes32[](HOLDER_COUNT);
        for (uint256 i = 0; i < HOLDER_COUNT; ++i) {
            layer[i] = keccak256(abi.encodePacked(holders[i], holderShares[i]));
        }

        // Compute proof depth ahead of time (ceil(log2(HOLDER_COUNT)) for HOLDER_COUNT=5 = 3).
        uint256 depth;
        uint256 cur = HOLDER_COUNT;
        while (cur > 1) {
            depth++;
            cur = (cur + 1) / 2;
        }
        proof = new bytes32[](depth);

        uint256 idx = target;
        uint256 n = HOLDER_COUNT;
        uint256 d;
        while (n > 1) {
            uint256 sibling = idx ^ 1;
            if (sibling < n) {
                proof[d] = layer[sibling];
            } else {
                // Odd-out node — pad with the same hash (matches `_buildRoot`'s last-odd
                // handling).
                proof[d] = layer[idx];
            }
            // Roll up to next layer.
            uint256 next = (n + 1) / 2;
            for (uint256 i = 0; i < next; ++i) {
                if (2 * i + 1 < n) {
                    bytes32 a = layer[2 * i];
                    bytes32 b = layer[2 * i + 1];
                    layer[i] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
                } else {
                    layer[i] = layer[2 * i];
                }
            }
            idx /= 2;
            n = next;
            d++;
        }
    }

    // ============================================================ Bounded actions
    //
    // Each entry below is a fuzz-target. Numeric inputs are `bound`-ed; out-of-phase calls
    // are gated and treated as no-ops (the fuzzer counts them but state is unchanged).

    /// @notice Drive a filter event with a single random loser and a bounded proceeds value.
    ///         The fuzzer's seed picks both. Updates ghost accruals using the same BPS math
    ///         the contract uses internally.
    function fuzz_processFilterEvent(uint256 loserSeed, uint256 proceedsSeed) external {
        ghostFilterEventCalls++;
        if (ghostWinnerSubmitted) return;

        uint256 idx = _firstUnliquidatedLoser(loserSeed);
        if (idx >= LOSER_COUNT) return;

        // Bound proceeds to a productive range. Lower bound 0 lets the fuzzer hit the
        // zero-proceeds branch; upper bound caps cumulative wei across the run.
        uint256 proceeds = bound(proceedsSeed, 0, MAX_PROCEEDS_PER_EVENT);

        // Stage proceeds inside the loser's locker so its `liquidateToWETH` returns this
        // amount and mints WETH to the vault. Reset proceeds first so re-stage on a previous
        // already-liquidated locker (defense in depth) is harmless.
        loserLockers[idx].setLiquidationProceeds(proceeds);
        // Pre-mint nothing extra here; the locker mints fresh WETH internally.

        address[] memory tokens = new address[](1);
        tokens[0] = losers[idx];
        uint256[] memory minOuts = new uint256[](1);

        vm.prank(oracle);
        try vault.processFilterEvent(tokens, minOuts) {
            // Mirror the vault's BPS math against ghost accruals. If proceeds == 0 the
            // contract no-ops past accumulator updates and so do we.
            if (proceeds == 0) return;
            ghostNonZeroFilterEvents++;
            uint256 bountySlice = (proceeds * 250) / 10_000;
            uint256 remainder = proceeds - bountySlice;
            uint256 rollover = (remainder * 4500) / 10_000;
            uint256 bonusSlice = (remainder * 2500) / 10_000;
            uint256 mech = (remainder * 1000) / 10_000;
            uint256 polSlice = (remainder * 1000) / 10_000;
            uint256 treasurySlice = remainder - rollover - bonusSlice - mech - polSlice;

            ghostTotalProceeds += proceeds;
            ghostBountyAccrued += bountySlice;
            ghostRolloverAccrued += rollover;
            ghostBonusAccrued += bonusSlice;
            ghostMechanicsAccrued += mech;
            ghostPolAccrued += polSlice;
            ghostTreasuryAccruedFromEvents += treasurySlice;
        } catch {
            // Reverts are fine — could be locker re-use, wrong phase, etc. The fuzzer
            // logs the call but state is unchanged.
        }
    }

    /// @notice Submit the winner. Allowed only once and only after at least one filter
    ///         event has produced proceeds (otherwise rollover shares > 0 with empty pots
    ///         is fine but degenerate).
    function fuzz_submitWinner() external {
        if (ghostWinnerSubmitted) return;

        (bytes32 root, uint256 total) = _rolloverRoot();

        ghostInsideSubmitWinner = true;
        ghostPolCallCountAtPhaseEntry = polManager.callCount();

        vm.prank(oracle);
        try vault.submitWinner(winnerToken, root, total, 0, 0) {
            ghostWinnerSubmitted = true;
            // POL fired iff the manager's callCount advanced inside this call.
            if (polManager.callCount() > ghostPolCallCountAtPhaseEntry) {
                ghostPolDeployCount++;
            }
        } catch {}

        ghostInsideSubmitWinner = false;
    }

    /// @notice Holder claim path. Picks one of the configured holders by seed; computes the
    ///         honest Merkle proof; calls claimRollover from the holder's address.
    function fuzz_claimRollover(uint256 holderSeed) external {
        if (!ghostWinnerSubmitted) return;
        uint256 idx = holderSeed % HOLDER_COUNT;
        if (vault.claimed(holders[idx])) return;
        // The attacker holder is exercised through a dedicated reentrant path so its honest
        // claim doesn't accidentally short-circuit the reentry test.
        if (idx == attackerHolderIdx) return;

        bytes32[] memory proof = _proofForHolder(idx);
        vm.prank(holders[idx]);
        try vault.claimRollover(holderShares[idx], proof) {} catch {}
    }

    // ============================================================ Adversary actions
    //
    // Each of these MUST revert. If any returns success, the corresponding ghost flag
    // flips and the matching invariant fires.

    /// @notice Adversary tries to drive a filter event from a non-oracle address.
    function fuzz_adversaryProcessFilterEvent(uint256 loserSeed) external {
        if (ghostWinnerSubmitted) return;
        uint256 idx = _firstUnliquidatedLoser(loserSeed);
        if (idx >= LOSER_COUNT) return;

        address[] memory tokens = new address[](1);
        tokens[0] = losers[idx];
        uint256[] memory minOuts = new uint256[](1);

        vm.prank(adversary);
        try vault.processFilterEvent(tokens, minOuts) {
            ghostAuthBypass = true;
        } catch {}
    }

    /// @notice Adversary tries to submit a winner from a non-oracle address.
    function fuzz_adversarySubmitWinner() external {
        if (ghostWinnerSubmitted) return;

        (bytes32 root, uint256 total) = _rolloverRoot();
        vm.prank(adversary);
        try vault.submitWinner(winnerToken, root, total, 0, 0) {
            ghostAuthBypass = true;
        } catch {}
    }

    /// @notice Adversary tries to publish a bonus root before / outside oracle authority.
    ///         Bonus root publication is `BonusDistributor.postRoot` and is oracle-gated.
    function fuzz_adversaryPostBonusRoot() external {
        bytes32 root = keccak256(abi.encode("evil", block.number));
        vm.prank(adversary);
        try bonus.postRoot(SEASON_ID, root) {
            ghostAuthBypass = true;
        } catch {}
    }

    /// @notice Oracle attempts to re-call submitWinner after a successful submit. MUST
    ///         revert (phase guard + Merkle root immutability). Setting the bool here is
    ///         the immutable-root invariant's signal.
    function fuzz_attemptResubmitWinner() external {
        if (!ghostWinnerSubmitted) return;
        bytes32 evilRoot = keccak256(abi.encode("override", block.number));
        vm.prank(oracle);
        try vault.submitWinner(winnerToken, evilRoot, 1, 0, 0) {
            ghostMerkleRepublished = true;
        } catch {}
    }

    /// @notice Reentrant claim — arms the attacker, has it claim its rollover, expects the
    ///         malicious winner-token transfer hook to fire mid-claim and the inner
    ///         reentrant `claimRollover` re-call to revert via `ReentrancyGuard`.
    ///
    ///         Wiring (constructor): the winner is a `MaliciousERC20` whose `_update` hook
    ///         calls into `attacker.onTokenHook()` whenever `hookTarget != 0`. The hook is
    ///         pre-wired to the attacker, but `armed == false` by default so non-attack
    ///         transfers (mints during submitWinner, honest holder claims) are no-ops.
    ///
    ///         Attack flow:
    ///           1. `arm()` flips `armed = true` and stages the inner callback
    ///           2. attacker calls `claimRollover` (outer); the vault enters its
    ///              `nonReentrant` lock and `safeTransfer`s winner tokens to the attacker
    ///           3. `MaliciousERC20._update` fires the hook → `attacker._fire()` runs
    ///              the staged inner call against the same vault
    ///           4. Inner `claimRollover` hits the reentrancy guard → reverts → outer
    ///              `target.call(...)` returns `success = false` → `attacker.reentrySucceeded`
    ///              stays false (the contract is safe)
    ///           5. Outer transfer completes; outer claim succeeds; attacker holds tokens
    ///
    ///         If a future regression drops the `nonReentrant` modifier, step 4's inner
    ///         call would succeed → `attacker.reentrySucceeded` flips true → the invariant
    ///         fires and the test fails loudly.
    function fuzz_reentrantClaim() external {
        if (!ghostWinnerSubmitted) return;
        if (vault.claimed(address(attacker))) return;

        bytes32[] memory proof = _proofForHolder(attackerHolderIdx);

        // Clear the attacker's outcome flags so this cycle's reads reflect *this* call only.
        // `attacker` is shared with `fuzz_reentrantBonusClaim` and the flags are sticky --
        // without this reset, an earlier bonus-surface fire would set
        // `ghostReentryAttemptedAtLeastOnce` here even when this cycle's claim surface
        // didn't fire, weakening the anti-vacuousness signal. The handler-level ghosts
        // remain sticky across calls; only the per-cycle observation window is reset.
        attacker.clear();
        attacker.arm(
            address(vault),
            abi.encodeWithSelector(vault.claimRollover.selector, holderShares[attackerHolderIdx], proof)
        );

        vm.prank(address(attacker));
        try vault.claimRollover(holderShares[attackerHolderIdx], proof) {} catch {}

        // Bubble the attacker's per-cycle outcome into ghosts the invariants observe.
        if (attacker.reentryAttempted()) ghostReentryAttemptedAtLeastOnce = true;
        if (attacker.reentrySucceeded()) ghostReentrancyBypass = true;

        attacker.disarm();
    }

    /// @notice Audit C-1 regression cover: drives a re-entrant `claim()` against the dedicated
    ///         `bonusReentry` instance (backed by `bonusReentryWeth`, a hook-firing
    ///         MaliciousERC20). The attacker's transfer hook attempts to re-enter `claim()`
    ///         with the same proof while the outer claim is still in flight; the invariant
    ///         `invariant_bonusDistributor_reentrancySafe` asserts that across every fuzz run:
    ///           - re-entry never returns success
    ///           - bonus accounting (`claimedTotal <= reserve`) holds
    ///           - the attacker can't claim more than once
    ///         Once-claimed (sticky) — repeated calls become no-ops, which is the legitimate
    ///         post-claim state we want the fuzzer to also exercise.
    function fuzz_reentrantBonusClaim() external {
        if (bonusReentry.claimed(BONUS_REENTRY_SEASON, address(attacker))) return;

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _bonusReentryAttackerProof;

        // Clear before arming so `ghostBonusReentryAttempted` only flips when *this* cycle's
        // bonus-claim surface actually fires the hook. `attacker` is shared with
        // `fuzz_reentrantClaim` and `MaliciousReceiver`'s flags are sticky -- without this
        // reset, a prior `fuzz_reentrantClaim` fire would contaminate the bonus-surface
        // anti-vacuousness signal. Handler-level ghosts (`ghostBonusReentryAttempted`,
        // `ghostBonusReentryBypassed`) remain sticky across calls; this only refreshes the
        // per-cycle observation window on the underlying attacker.
        attacker.clear();
        attacker.arm(
            address(bonusReentry),
            abi.encodeWithSelector(
                bonusReentry.claim.selector, BONUS_REENTRY_SEASON, BONUS_REENTRY_RESERVE / 2, proof
            )
        );

        vm.prank(address(attacker));
        try bonusReentry.claim(BONUS_REENTRY_SEASON, BONUS_REENTRY_RESERVE / 2, proof) {} catch {}

        if (attacker.reentryAttempted()) ghostBonusReentryAttempted = true;
        if (attacker.reentrySucceeded()) ghostBonusReentryBypassed = true;

        attacker.disarm();
    }

    /// @notice Audit H-2 regression cover: rotate `launcher.oracle()` to a fresh address and
    ///         immediately probe both the prev-oracle (must reject) and the new oracle (must
    ///         keep authority). The vault's `onlyOracle` reads `launcher.oracle()` live, so a
    ///         post-rotation prev-oracle call MUST revert with NotOracle on every existing
    ///         per-season vault — that is the H-2 fix's load-bearing property.
    ///
    ///         Probe target: `processFilterEvent` against an empty losers array. The vault
    ///         hits the auth modifier BEFORE the EmptyEvent check, so an authorised caller
    ///         reverts with EmptyEvent (NOT NotOracle) and an unauthorised caller reverts
    ///         with NotOracle. Distinguishing those two reverts is what gives this probe its
    ///         teeth — `try {} catch (bytes memory err)` inspects the selector to tell the
    ///         two apart.
    ///
    ///         Skip rotation post-finalize: the bounded-action sequence settles on
    ///         `submitWinner`, after which an oracle rotation has no further auth surface to
    ///         exercise (every onlyOracle entry point is also phase-gated to Phase.Active).
    ///         Rotating then would be wasted fuzz steps; the regression cover focuses on the
    ///         pre-finalize window where rotation is operationally relevant.
    function fuzz_rotateLauncherOracle(uint256 newOracleSeed) external {
        if (ghostWinnerSubmitted) return;

        address newOracle = address(uint160(uint256(keccak256(abi.encode("oracle.rotate", newOracleSeed)))));
        // Avoid trivial rotations to address(0) (would bypass the auth check via msg.sender ==
        // address(0)) or to the current oracle (no-op).
        if (newOracle == address(0) || newOracle == oracle) return;

        address prev = oracle;
        launcher.setOracle(newOracle);
        oracle = newOracle;
        ghostPrevOracle = prev;
        ++ghostOracleRotations;

        // Probe 1: prev-oracle MUST be rejected with NotOracle.
        address[] memory empty = new address[](0);
        uint256[] memory emptyOuts = new uint256[](0);
        vm.prank(prev);
        try vault.processFilterEvent(empty, emptyOuts) {
            // Authority did not flip — H-2 regression. Surfaces via ghostAuthBypass so the
            // existing oracle-authority invariant ALSO fires, double-flagging the bug.
            ghostAuthBypass = true;
        } catch (bytes memory err) {
            // Inspect the revert selector. NotOracle (the vault's selector) is what we need
            // to see; any OTHER revert (e.g. EmptyEvent) means auth passed and the prev
            // oracle still has power — also a regression.
            bytes4 sel;
            if (err.length >= 4) {
                assembly {
                    sel := mload(add(err, 32))
                }
            }
            if (sel == SeasonVault.NotOracle.selector) {
                ghostPrevOracleRejectedAtLeastOnce = true;
            } else {
                // Auth passed (revert was for a non-auth reason) — prev oracle still
                // privileged → H-2 regression.
                ghostAuthBypass = true;
            }
        }

        // Probe 2: new oracle MUST keep authority. Same empty-event probe; expected revert
        // is EmptyEvent (auth passed, body rejected). NotOracle here would mean the
        // launcher rotation didn't propagate.
        vm.prank(newOracle);
        try vault.processFilterEvent(empty, emptyOuts) {
            // Empty arrays should always revert with EmptyEvent; a success here is a
            // separate invariant violation but unrelated to H-2 — record it loudly anyway.
            ghostAuthBypass = true;
        } catch (bytes memory err) {
            bytes4 sel;
            if (err.length >= 4) {
                assembly {
                    sel := mload(add(err, 32))
                }
            }
            if (sel == SeasonVault.NotOracle.selector) {
                // The new oracle was rejected — launcher rotation did NOT propagate to the
                // vault. This is the exact H-2 regression. Flag via the same ghost so both
                // invariants light up.
                ghostAuthBypass = true;
            }
            // Otherwise (EmptyEvent or any non-NotOracle revert): auth passed as expected.
        }
    }

    // ============================================================ Views (for invariants)

    /// @notice View into the bonus-reentry harness's current accounting state. Exposed so
    ///         the invariant suite can assert `claimedTotal <= reserve` without needing to
    ///         re-encode the storage layout.
    function bonusReentryClaimedTotal() external view returns (uint256) {
        return bonusReentry.bonusOf(BONUS_REENTRY_SEASON).claimedTotal;
    }

    function bonusReentryReserve() external view returns (uint256) {
        return bonusReentry.bonusOf(BONUS_REENTRY_SEASON).reserve;
    }

    function bonusReentryClaimedByAttacker() external view returns (bool) {
        return bonusReentry.claimed(BONUS_REENTRY_SEASON, address(attacker));
    }

    function bonusReentryAttackerWethBalance() external view returns (uint256) {
        return bonusReentryWeth.balanceOf(address(attacker));
    }

    function totalSlicesAccrued() external view returns (uint256) {
        return ghostBountyAccrued + ghostRolloverAccrued + ghostBonusAccrued + ghostMechanicsAccrued
            + ghostPolAccrued + ghostTreasuryAccruedFromEvents;
    }
}
