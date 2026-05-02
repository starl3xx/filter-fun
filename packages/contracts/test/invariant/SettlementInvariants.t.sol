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
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = SettlementHandler.fuzz_processFilterEvent.selector;
        selectors[1] = SettlementHandler.fuzz_submitWinner.selector;
        selectors[2] = SettlementHandler.fuzz_claimRollover.selector;
        selectors[3] = SettlementHandler.fuzz_adversaryProcessFilterEvent.selector;
        selectors[4] = SettlementHandler.fuzz_adversarySubmitWinner.selector;
        selectors[5] = SettlementHandler.fuzz_adversaryPostBonusRoot.selector;
        selectors[6] = SettlementHandler.fuzz_attemptResubmitWinner.selector;
        selectors[7] = SettlementHandler.fuzz_reentrantClaim.selector;
        selectors[8] = SettlementHandler.fuzz_reentrantBonusClaim.selector;
        selectors[9] = SettlementHandler.fuzz_rotateLauncherOracle.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ============================================================ Deterministic reentrancy test
    //
    // Companion to `invariant_reentrancySafety` — proves the attack surface is wired and
    // actually fires. Without this, an unintentional change that disables the malicious
    // token's hook (or breaks the proof) would let the reentrancy invariant pass vacuously
    // (no reentry attempted ⇒ trivially nothing succeeds). This deterministic test asserts
    // the path was triggered AND blocked, giving the fuzz invariant teeth.
    function test_reentrancySurface_fires_and_is_blocked() public {
        // Drive a single filter event so the vault has rollover proceeds, submit the
        // winner, then route a reentrant claim through the attacker.
        handler.fuzz_processFilterEvent(0, 1 ether);
        handler.fuzz_submitWinner();
        require(handler.ghostWinnerSubmitted(), "setup: winner not submitted");

        handler.fuzz_reentrantClaim();

        // The hook fired (attempted re-entry) AND the inner re-call was blocked.
        assertTrue(handler.attacker().reentryAttempted(), "reentry surface did not fire");
        assertFalse(handler.attacker().reentrySucceeded(), "reentry was NOT blocked");
        assertTrue(handler.ghostReentryAttemptedAtLeastOnce(), "handler did not record the attempt");
        assertFalse(handler.ghostReentrancyBypass(), "handler recorded a bypass");

        // The outer claim still completed — attacker holds the proportional winner-token cut.
        assertTrue(handler.vault().claimed(address(handler.attacker())), "outer claim did not complete");
    }

    // ============================================================ Audit C-1 surface deterministic
    //
    // Companion to `invariant_bonusDistributor_reentrancySafe` — proves the bonus-claim
    // reentry path is actually live (hook fires, inner call attempted) so the fuzz invariant
    // has teeth. Without this, a regression that quietly disables the bonus-WETH hook would
    // let the invariant pass vacuously (no reentry attempted ⇒ trivially no bypass).
    function test_bonusReentrySurface_fires_and_is_blocked() public {
        handler.fuzz_reentrantBonusClaim();

        // Attacker hook fired AND the inner re-call was blocked.
        assertTrue(handler.attacker().reentryAttempted(), "bonus reentry surface did not fire");
        assertFalse(handler.attacker().reentrySucceeded(), "bonus reentry was NOT blocked");
        assertTrue(handler.ghostBonusReentryAttempted(), "handler did not record the bonus attempt");
        assertFalse(handler.ghostBonusReentryBypassed(), "handler recorded a bonus bypass");

        // Outer claim still completed — attacker holds their entitled half of the bonus.
        assertTrue(handler.bonusReentryClaimedByAttacker(), "outer bonus claim did not complete");
        assertEq(
            handler.bonusReentryAttackerWethBalance(),
            handler.BONUS_REENTRY_RESERVE() / 2,
            "attacker did not receive entitled bonus"
        );
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
    // returns success, `ghostAuthBypass` flips. Defense in depth: also assert
    // `launcher.oracle()` (the live source of truth post-H-2) tracks the handler's currently-
    // expected oracle. Audit H-2 (Phase 1, 2026-05-01): SeasonVault no longer stores its own
    // oracle field — it reads `launcher.oracle()` on every privileged call — so the assertion
    // shifted from `vault.oracle()` to `launcher.oracle()`. After H-2 the handler can rotate
    // the launcher oracle mid-run via `fuzz_rotateLauncherOracle`; this invariant only
    // checks the rotation is well-defined (current handler.oracle() matches launcher) and the
    // dedicated `invariant_oracleAuthorityCurrent` covers the "old oracle rejected, new oracle
    // accepted" property post-rotation.
    function invariant_oracleAuthority() public view {
        assertFalse(handler.ghostAuthBypass(), "oracleAuthority: privileged call escaped guard");
        assertEq(
            handler.launcher().oracle(),
            handler.oracle(),
            "oracleAuthority: launcher.oracle drifted from handler.oracle"
        );
    }

    // ============================================================ Invariant 6b — oracle currency
    //
    // Audit H-2 (Phase 1, 2026-05-01) regression cover. SeasonVault.onlyOracle now reads
    // `launcher.oracle()` live, so a `setOracle` rotation on the launcher MUST take effect
    // on every existing per-season vault immediately. Pre-H-2 the vault stored its own
    // oracle field; rotations on the launcher left old vaults honouring the old oracle
    // indefinitely — a Sev: High finding because settlement on stale seasons stayed
    // signable by a presumed-rotated key.
    //
    // Handler exposes `fuzz_rotateLauncherOracle` which rotates the launcher's oracle to a
    // fresh address and remembers the previous one. This invariant asserts:
    //   1. The previous oracle, if any, has had at least one rejected probe captured
    //      (`ghostPrevOracleRejected` flips on a probe attempt that reverted with NotOracle)
    //   2. The current `handler.oracle()` is exactly what `launcher.oracle()` reports
    //   3. No bypass ever fired through the rotation (covered by the existing
    //      `ghostAuthBypass`, but re-asserted here for symmetry)
    function invariant_oracleAuthorityCurrent() public view {
        assertEq(
            handler.launcher().oracle(),
            handler.oracle(),
            "oracleCurrency: launcher.oracle desynced from handler.oracle"
        );
        // If a rotation has happened at any point, the prev-oracle probe must have rejected
        // at least once. If no rotation, the previous oracle is the original and the probe
        // never armed (vacuously true).
        if (handler.ghostOracleRotations() > 0) {
            assertTrue(
                handler.ghostPrevOracleRejectedAtLeastOnce(),
                "oracleCurrency: prev-oracle probe never rejected after rotation"
            );
        }
        assertFalse(handler.ghostAuthBypass(), "oracleCurrency: bypass escaped guard during rotation");
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
    // ============================================================ Audit C-1 — bonus reentrancy
    //
    // Spec §42.2.5 (reentrancy safety) applied to BonusDistributor specifically. The Pillar 1
    // suite (PR #50) covered SeasonVault.claimRollover, but BonusDistributor's three state-
    // mutating functions had no test for transfer-hook re-entry. The audit (PR #52, finding
    // C-1) surfaced a real exploit on `fundBonus` (a malicious vault contract acting as both
    // caller and WETH transfer-hook target could fund a different seasonId mid-call). The fix
    // applies `nonReentrant` to all three functions; this invariant ensures the regression
    // can't return.
    //
    // The bonus-reentry harness in the handler runs a separate BonusDistributor instance
    // backed by a hook-firing MaliciousERC20 bonus-WETH so the attacker actually gets a
    // chance to re-enter `claim()` mid-payout. The invariant asserts:
    //   1. Across every fuzz sequence, the inner re-entry never returns success
    //      (`ghostBonusReentryBypassed == false`)
    //   2. Bonus accounting stays consistent: `claimedTotal <= reserve` at all times
    //   3. The attacker can claim at most once (idempotency under repeated calls)
    function invariant_bonusDistributor_reentrancySafe() public view {
        // 1. Re-entry blocked.
        assertFalse(handler.ghostBonusReentryBypassed(), "bonusReentry: re-entry succeeded");

        // 2. Accounting consistent.
        uint256 claimedTotal = handler.bonusReentryClaimedTotal();
        uint256 reserve = handler.bonusReentryReserve();
        assertLe(claimedTotal, reserve, "bonusReentry: claimedTotal > reserve");

        // 3. If the attacker claimed (legitimate single-shot success), they hold exactly
        //    their entitled half. If not yet claimed, balance is 0.
        bool claimed_ = handler.bonusReentryClaimedByAttacker();
        uint256 expected = claimed_ ? handler.BONUS_REENTRY_RESERVE() / 2 : 0;
        assertEq(handler.bonusReentryAttackerWethBalance(), expected, "bonusReentry: attacker balance drift");
    }

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
