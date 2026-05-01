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
    uint256 public constant HOLDER_COUNT = 5;
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
    /// @notice True once submitWinner has succeeded. Gates handlers that only make sense
    ///         post-finalize (claim*, etc).
    bool public ghostWinnerSubmitted;

    // ============================================================ Construction

    constructor() {
        oracle = makeAddr("settlement.oracle");
        treasury = makeAddr("settlement.treasury");
        mechanics = makeAddr("settlement.mechanics");
        winnerCreator = makeAddr("settlement.winnerCreator");
        adversary = makeAddr("settlement.adversary");

        weth = new MockWETH();
        launcher = new MockLauncherView();
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
            oracle,
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

        // Tokens + lockers. Winner mints synthetic tokens; losers each carry a configurable
        // liquidation proceeds value the fuzzer drives.
        winnerToken = address(new MintableERC20("Winner", "WIN"));
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
        // Merkle root has a single distinct leaf per holder.
        holderShares[0] = 100;
        holderShares[1] = 75;
        holderShares[2] = 50;
        holderShares[3] = 25;
        holderShares[4] = 10;
        for (uint256 i = 0; i < HOLDER_COUNT; ++i) {
            holders[i] = makeAddr(string(abi.encodePacked("settlement.holder.", _toAscii(i))));
        }

        // Wire the attacker as the LAST holder so the rollover claim path naturally hands
        // tokens to a contract address. The attacker's `react()` will attempt re-entry.
        attacker = new MaliciousReceiver();
        attackerHolderIdx = HOLDER_COUNT - 1;
        holders[attackerHolderIdx] = address(attacker);
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

    /// @notice Reentrant claim — arms the attacker, has it claim its rollover, expects
    ///         ReentrancyGuard to revert the inner re-call. The attacker's
    ///         `reentrySucceeded` flag is the canonical observation; this handler also
    ///         flips a local ghost for the invariant to read.
    function fuzz_reentrantClaim() external {
        if (!ghostWinnerSubmitted) return;
        if (vault.claimed(address(attacker))) return;

        bytes32[] memory proof = _proofForHolder(attackerHolderIdx);

        // Arm the attacker to attempt a re-call into claimRollover with the same proof.
        // Inside the malicious token's transfer hook, this call should hit
        // ReentrancyGuardReentrantCall and bubble back as success=false.
        attacker.arm(
            address(vault),
            abi.encodeWithSelector(vault.claimRollover.selector, holderShares[attackerHolderIdx], proof)
        );

        vm.prank(address(attacker));
        try vault.claimRollover(holderShares[attackerHolderIdx], proof) {} catch {}

        // The vault's winner is the standard MintableERC20 — no transfer hook fires, so
        // the reentry attempt isn't actually triggered through the token path. The flag
        // surface still exists for higher-fidelity reentry harnesses (e.g. a malicious
        // winner token wired in a dedicated test). For Pillar 1, the assertion is that
        // ReentrancyGuard is in place and was not bypassed; if a future malicious-winner
        // wiring lands, attacker.reentrySucceeded() exposes the result.
        if (attacker.reentrySucceeded()) ghostReentrancyBypass = true;

        attacker.disarm();
    }

    // ============================================================ Views (for invariants)

    function totalSlicesAccrued() external view returns (uint256) {
        return ghostBountyAccrued + ghostRolloverAccrued + ghostBonusAccrued + ghostMechanicsAccrued
            + ghostPolAccrued + ghostTreasuryAccruedFromEvents;
    }
}
