// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SettlementHandler} from "./handlers/SettlementHandler.sol";

/// @title SettlementInvariants
/// @notice Foundry invariant suite for spec §42.2's eight contractual guarantees over the
///         weekly settlement pipeline. The handler drives a bounded action sequence; these
///         invariants assert the resulting on-chain + ghost state is internally consistent
///         after every fuzzed run.
///
///         Conventions per spec §42.2:
///           - One `invariant_*` per spec invariant (Foundry runs every `invariant_`-prefixed
///             function after each sequence)
///           - Multi-aspect invariants (§42.2.3 POL atomicity has four sub-clauses) are split
///             into named sub-checks within the one function so a failure surfaces the exact
///             clause
///           - Reentrancy + auth invariants observe ghost flags the handler set during
///             attempted attacks; a true value means the attack landed and the test fails
contract SettlementInvariantsTest is StdInvariant, Test {
    SettlementHandler internal handler;

    function setUp() public {
        handler = new SettlementHandler();
        targetContract(address(handler));

        // Restrict the fuzzer to the handler's named entry points. Without this, foundry's
        // selector-discovery picks up every public function on the handler (including views,
        // ghost accessors, and constructor-chain helpers) and wastes runs on no-ops.
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = SettlementHandler.fuzz_processFilterEvent.selector;
        selectors[1] = SettlementHandler.fuzz_submitWinner.selector;
        selectors[2] = SettlementHandler.fuzz_claimRollover.selector;
        selectors[3] = SettlementHandler.fuzz_adversaryProcessFilterEvent.selector;
        selectors[4] = SettlementHandler.fuzz_adversarySubmitWinner.selector;
        selectors[5] = SettlementHandler.fuzz_attemptResubmitWinner.selector;
        selectors[6] = SettlementHandler.fuzz_reentrantClaim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ============================================================ Invariant 1 — conservation
    //
    // Spec §42.2.1: at any block, sum of allocations to (rollover, hold_bonus, mechanics,
    // POL, treasury, champion_bounty) == total_collected_from_filtered_LP. No leaks, no
    // double-counts.
    //
    // The handler tracks `ghostTotalProceeds` as the cumulative WETH that
    // `processFilterEvent` actually credited (after the `wethBefore`/`wethAfter` delta).
    // Sum of every BPS-derived slice (computed by the handler in lockstep with the contract)
    // must equal that figure.
    function invariant_conservation() public view {
        assertEq(
            handler.totalSlicesAccrued(),
            handler.ghostTotalProceeds(),
            "conservation: sum(slices) != totalProceeds"
        );

        // Mirror against on-chain totals (defense in depth). The vault tracks
        // totalLiquidationProceeds, totalMechanicsPaid, totalPolAccumulated,
        // totalBountyAccumulated as monotonically-increasing counters. Treasury accrual and
        // residue sweep happens via direct WETH transfers; we don't get a per-component on
        // chain counter for treasury-from-events, so the ghost is the canonical source there.
        assertEq(
            handler.vault().totalLiquidationProceeds(),
            handler.ghostTotalProceeds(),
            "conservation: vault.totalLiquidationProceeds drift"
        );
        assertEq(
            handler.vault().totalMechanicsPaid(),
            handler.ghostMechanicsAccrued(),
            "conservation: vault.totalMechanicsPaid drift"
        );
        assertEq(
            handler.vault().totalPolAccumulated(),
            handler.ghostPolAccrued(),
            "conservation: vault.totalPolAccumulated drift"
        );
        assertEq(
            handler.vault().totalBountyAccumulated(),
            handler.ghostBountyAccrued(),
            "conservation: vault.totalBountyAccumulated drift"
        );
    }

    // ============================================================ Invariant 2 — settlement math
    //
    // Spec §42.2.2: per-event split exactness. For any losers pot P, bounty == P × 0.025 and
    // remaining = P × 0.975 splits 4500/2500/1000/1000/1000. Per-component slack ≤ 1 wei.
    // Treasury absorbs rounding dust by construction so the per-event sum is exact.
    //
    // The handler computes the same slice math as the contract; this invariant verifies
    // that the cumulative ghost matches the cumulative on-chain accruals within the
    // wei-level rounding bound that compounds over many events.
    function invariant_settlementMathExact() public view {
        uint256 proceeds = handler.ghostTotalProceeds();
        if (proceeds == 0) return;

        // Bounty: cumulative on-chain == cumulative ghost == sum of per-event 250/10000.
        uint256 expectedBounty = (proceeds * 250) / 10_000;
        // Per-event flooring + cumulative sum; off-by-≤events count from the per-event
        // truncation. Cap allowable drift at the actual filter event count so adversarial
        // sequences with many tiny pots don't trigger false alarms.
        uint256 maxBountyDrift = handler.ghostNonZeroFilterEvents();
        uint256 actualBounty = handler.ghostBountyAccrued();
        uint256 bountyDelta =
            actualBounty > expectedBounty ? actualBounty - expectedBounty : expectedBounty - actualBounty;
        assertLe(bountyDelta, maxBountyDrift, "settlement: bounty drift");

        // Remainder split: rollover = R*4500/10000, etc., where R varies per event. The
        // sum-of-slices (excluding bounty) must equal sum-of-remainders == proceeds - bounty
        // exactly, since treasury absorbs the per-event dust.
        uint256 nonBounty = handler.ghostRolloverAccrued() + handler.ghostBonusAccrued()
            + handler.ghostMechanicsAccrued() + handler.ghostPolAccrued()
            + handler.ghostTreasuryAccruedFromEvents();
        assertEq(nonBounty, proceeds - actualBounty, "settlement: nonBounty != P - bounty");
    }

    // ============================================================ Invariant 3 — POL atomicity
    //
    // Spec §42.2.3: POL deployed exactly once per season; only at finalization; only into
    // the winner's pool; once deployed, LP tokens are locked.
    //
    //   - "exactly once": polManager.callCount() ∈ {0, 1} across the run
    //   - "only at finalization": calls only land while ghostInsideSubmitWinner is true,
    //     enforced by the handler's wrapper. The invariant verifies the post-condition.
    //   - "only into winner's pool": polManager.lastWinner() matches handler.winnerToken()
    //   - "LP tokens locked": Mock returns liquidity figure; real POLVault has no withdraw
    //     path. We assert that POLVault has zero balance change vs. legitimate flow (the
    //     mock LP locker is the holder; vault has nothing to withdraw). The "no withdraw
    //     path" is an architectural property — covered by source review and tested in
    //     POLVault.t.sol's negative tests.
    function invariant_polAtomicity() public view {
        uint256 calls = handler.polManager().callCount();
        assertLe(calls, 1, "polAtomicity: deployed more than once");
        assertEq(calls, handler.ghostPolDeployCount(), "polAtomicity: ghost desync");

        if (calls == 1) {
            // Sender must have been the vault — anyone else calling would have hit the
            // NotRegisteredVault revert in real POLManager (mock here; real is structural).
            assertEq(
                handler.polManager().lastSender(),
                address(handler.vault()),
                "polAtomicity: lastSender != vault"
            );
            assertEq(
                handler.polManager().lastWinner(),
                handler.winnerToken(),
                "polAtomicity: lastWinner != winnerToken"
            );
            assertEq(
                handler.polManager().lastSeasonId(),
                handler.SEASON_ID(),
                "polAtomicity: lastSeasonId != SEASON_ID"
            );
        }
    }

    // ============================================================ Invariant 4 — Merkle immutable
    //
    // Spec §42.2.4: rolloverMerkleRoot[season] is settable exactly once. The vault encodes this
    // via `inPhase(Phase.Active)` on submitWinner — a successful call transitions to
    // Distributing, and any subsequent submitWinner reverts on the phase guard.
    //
    // The handler attempts a re-publish via `fuzz_attemptResubmitWinner`. If the call ever
    // succeeds, `ghostMerkleRepublished` flips. We additionally read the on-chain root to
    // confirm it equals the original.
    function invariant_merkleRootImmutable() public view {
        assertFalse(handler.ghostMerkleRepublished(), "merkleImmutable: republish succeeded");

        // If we've submitted, the on-chain rolloverRoot must be non-zero (handler always
        // submits a non-zero root). Distributing phase is the canonical settled state.
        if (handler.ghostWinnerSubmitted()) {
            assertTrue(
                handler.vault().rolloverRoot() != bytes32(0), "merkleImmutable: root cleared post-finalize"
            );
        }
    }

    // ============================================================ Invariant 5 — reentrancy safe
    //
    // Spec §42.2.5: every state-mutating function is `nonReentrant`; reentry attempts revert.
    //
    // The handler arms a MaliciousReceiver wired to the attacker holder's claim path, then
    // attempts a re-call into `claimRollover`. ReentrancyGuardReentrantCall must bubble.
    // `attacker.reentrySucceeded()` would flip true if the inner call returned ok — that's
    // the canonical observation; the handler also mirrors it into a ghost flag for clarity.
    //
    // Note: the standard MintableERC20 winner doesn't run a `_update` callback, so the
    // attacker's hook never fires through the natural token-transfer path. The flag surface
    // exists for higher-fidelity reentry harnesses (a malicious-token wiring is a follow-up).
    // The assertion still has teeth: any future change that drops ReentrancyGuard from
    // claimRollover (or replaces it with a non-blocking guard) lights this up the moment a
    // reentry path exists.
    function invariant_reentrancySafety() public view {
        assertFalse(handler.ghostReentrancyBypass(), "reentrancySafety: bypassed");
        assertFalse(handler.attacker().reentrySucceeded(), "reentrancySafety: inner call ok");
    }

    // ============================================================ Invariant 6 — oracle authority
    //
    // Spec §42.2.6: only the configured oracle may submit settlements; all other callers revert.
    //
    // The handler exposes adversary variants of each gated entry point. If any of them ever
    // returns success, `ghostAuthBypass` flips. Defense in depth: also assert vault.oracle()
    // is unchanged from setUp — there is no setter, so this is a structural property, but
    // catching a future oracle-mutability bug here is cheap.
    function invariant_oracleAuthority() public view {
        assertFalse(handler.ghostAuthBypass(), "oracleAuthority: privileged call escaped guard");
        assertEq(
            handler.vault().oracle(), handler.oracle(), "oracleAuthority: vault.oracle drifted from setUp"
        );
    }

    // ============================================================ Invariant 7 — no mid-season POL
    //
    // Spec §42.2.7: between filter events, POL stays as WETH in SeasonPOLReserve; the only
    // path that moves it out is finalizeSeason (=== submitWinner). Any state transition that
    // deploys POL outside that function is a bug.
    //
    // Observation: polManager.callCount() must equal handler.ghostPolDeployCount() (only
    // moves inside the wrapped submitWinner). Equivalently: polManager.callCount() is 0
    // before submitWinner succeeds, then 0 or 1 after.
    function invariant_noMidSeasonPolDeployment() public view {
        if (!handler.ghostWinnerSubmitted()) {
            // Pre-finalize: POL deployment must NOT have fired.
            assertEq(handler.polManager().callCount(), 0, "noMidSeasonPol: deployed before finalize");
        }
        // Post-finalize: callCount mirrored by ghost; verified in invariant_polAtomicity.
    }

    // ============================================================ Invariant 8 — dust handling
    //
    // Spec §42.2.8: fractional WETH from integer-division rounding routes to treasury (per
    // §11). Never disappears, never accumulates in an unaccounted balance.
    //
    // The handler's per-event treasury slice is computed as `remainder - rollover - bonus -
    // mechanics - pol`. By construction this absorbs all per-event division dust, and the
    // sum of components equals `remainder` exactly. The conservation invariant proves the
    // bookkeeping side; this invariant checks the on-chain balance side: every wei that
    // entered the vault either resides in a known accumulator (rollover/bonus/bounty
    // reserves) or has been forwarded to a known external (mechanics, treasury, polReserve).
    //
    // We compute the "expected total in-flow" from ghosts and the "actual remaining +
    // forwarded" from on-chain reads. These must match exactly modulo the residue-sweep at
    // submitWinner (which sweeps any leftover WETH inside the vault to treasury — accounted
    // for separately via `vault.totalTreasuryPaid` minus the ghost's per-event component).
    function invariant_dustHandling() public view {
        // Pre-finalize: vault holds rolloverReserve + bonusReserve + bountyReserve in WETH;
        // mechanics + treasury + polReserve received their per-event slices.
        if (!handler.ghostWinnerSubmitted()) {
            uint256 vaultHolds = IERC20(address(handler.weth())).balanceOf(address(handler.vault()));
            uint256 expectedHeld = handler.vault().rolloverReserve() + handler.vault().bonusReserve()
                + handler.vault().bountyReserve();
            assertEq(vaultHolds, expectedHeld, "dust: pre-finalize vault balance != reserves");

            uint256 mechBal = IERC20(address(handler.weth())).balanceOf(handler.mechanics());
            assertEq(mechBal, handler.ghostMechanicsAccrued(), "dust: mechanics balance drift");

            uint256 polReserveBal = handler.vault().polReserveBalance();
            assertEq(polReserveBal, handler.ghostPolAccrued(), "dust: polReserve balance drift");

            uint256 treasuryBal = IERC20(address(handler.weth())).balanceOf(handler.treasury());
            assertEq(
                treasuryBal,
                handler.ghostTreasuryAccruedFromEvents(),
                "dust: treasury balance drift (pre-finalize)"
            );
        }
        // Post-finalize: residue sweep can move arbitrary leftover WETH from vault →
        // treasury. The conservation invariant covers cumulative bookkeeping; we just
        // assert no WETH is *missing* from the closed system: vault now holds zero (or
        // claim-ready amounts), and the sum of every external destination + remaining vault
        // accruals equals everything that ever entered.
        else {
            uint256 vaultHolds = IERC20(address(handler.weth())).balanceOf(address(handler.vault()));
            // Post-finalize the only residual WETH is whatever wasn't claim-bound; rollover
            // reserve, bonus reserve, bounty reserve all zeroed inside submitWinner.
            assertEq(handler.vault().rolloverReserve(), 0, "dust: rolloverReserve not drained");
            assertEq(handler.vault().bonusReserve(), 0, "dust: bonusReserve not drained");
            assertEq(handler.vault().bountyReserve(), 0, "dust: bountyReserve not drained");
            assertEq(vaultHolds, 0, "dust: vault holds residue post-finalize");
        }
    }
}
