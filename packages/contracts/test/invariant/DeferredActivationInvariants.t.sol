// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {DeferredActivationHandler} from "./handlers/DeferredActivationHandler.sol";
import {FilterClubPass} from "../../src/FilterClubPass.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";

/// @title DeferredActivationInvariants
/// @notice Spec §46 invariant suite — the three contractual guarantees over the
///         deferred-activation reservation flow:
///
///           inv_no_orphaned_escrow   — past hour 48, every reservation has either
///                                       `released == true` (token deployed) OR
///                                       `refunded == true` (creator made whole). No
///                                       reservation lingers in escrow.
///           inv_activation_atomicity — the 4th-reservation tx either fully lands the
///                                       cohort (4 tokens deployed) or fully reverts. Never
///                                       a partial activation (e.g. activated == true with
///                                       launchCount < 4).
///           inv_ticker_uniqueness    — `seasonTickers[seasonId]` is injective: no two
///                                       reservations agree on `tickerHash`. Per-season
///                                       state matches the ghost ticker registry.
///
///         Filter Club extension (spec §47.3.8 / Epic 2.6) — four more properties over the
///         lifetime-pass credit flow, driven by the handler's mint / credit-reserve /
///         transfer / arm / reclaim selectors:
///
///           inv_credit_conservation  — sum of `creditsOf` across every minted pass plus the
///                                       outstanding (consumed − reclaimed) records always
///                                       equals `totalMinted × CREDITS_PER_TOKEN`. Credits
///                                       are never minted from thin air nor silently burned.
///           inv_pass_zero_balance    — the pass contract's ETH balance is invariantly 0
///                                       (mint proceeds push through per-mint).
///           inv_supply_cap           — `totalMinted() <= maxSupply` under any sequence.
///           inv_escrow_balance       — the escrow's ETH balance equals the sum of live
///                                       (unreleased, unrefunded) reservation amounts plus
///                                       pending pull-refund credits — zero-amount credit
///                                       reservations are first-class rows contributing 0.
///
///         CI runs at the default `[invariant] runs = 256, depth = 500` per `foundry.toml`.
///         A `forge test --profile deep` run bumps to 1024 runs for pre-audit sweeps.
contract DeferredActivationInvariantsTest is StdInvariant, Test {
    DeferredActivationHandler internal handler;

    function setUp() public {
        handler = new DeferredActivationHandler();
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = DeferredActivationHandler.fuzz_reserve.selector;
        selectors[1] = DeferredActivationHandler.fuzz_warpAndAbort.selector;
        selectors[2] = DeferredActivationHandler.fuzz_mintPass.selector;
        selectors[3] = DeferredActivationHandler.fuzz_creditReserve.selector;
        selectors[4] = DeferredActivationHandler.fuzz_transferPass.selector;
        selectors[5] = DeferredActivationHandler.fuzz_armCredit.selector;
        selectors[6] = DeferredActivationHandler.fuzz_reclaimCredit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Spec §46 invariant 1 — past h48 there is no escrowed reservation that hasn't
    ///         either deployed or refunded. Iterates over every creator the handler has
    ///         observed and checks the escrow's lifecycle bits.
    function invariant_noOrphanedEscrow() public view {
        uint256 sid = handler.SEASON_ID();
        // Only meaningful past h48 — before that, `released == false && refunded == false`
        // is the legitimate "still pending" state.
        if (block.timestamp < 48 hours) return;

        LaunchEscrow escrow = handler.escrow();
        uint256 n = handler.ghostReserverCount();
        for (uint256 i = 0; i < n; ++i) {
            address creator = handler.ghostReservers(i);
            LaunchEscrow.Reservation memory r = escrow.escrowOf(sid, creator);
            // Carve-out: `RefundFailed` on a contract recipient leaves `refunded == false`
            // intentionally so the operator runbook can manually rescue. Treat that as a
            // legal terminal-state too. The handler's creator pool is all EOAs (vm.deal'd
            // addresses), so this carve-out shouldn't fire under fuzz, but expressed
            // defensively.
            bool ok =
                r.released || r.refunded || (handler.launcher().aborted(sid) && _refundFailedFor(creator));
            assertTrue(ok, "orphaned escrow past h48");
        }
    }

    /// @notice Spec §46 invariant 2 — activation is atomic. If `activated == true` then
    ///         `launchCount` MUST equal the activation threshold (4) at minimum, AND the
    ///         pending queue MUST be empty. Catches a hypothetical partial-deploy where the
    ///         flag flipped but only some tokens deployed.
    function invariant_activationAtomicity() public view {
        uint256 sid = handler.SEASON_ID();
        if (!handler.launcher().activated(sid)) return;

        uint256 launchCount = handler.launcher().launchCount(sid);
        uint256 threshold = handler.launcher().ACTIVATION_THRESHOLD();
        // Activated → at least 4 tokens deployed.
        assertGe(launchCount, threshold, "activated but launchCount < threshold");
        // Pending queue MUST be drained (slot 0..3 deployed in batch, slots 5..12 deploy on
        // entry without queuing).
        assertEq(handler.launcher().pendingCount(sid), 0, "pending non-empty post-activate");
        // launchCount must agree with reservationCount once activation is done — they
        // re-converge at activation moment and march in lockstep thereafter.
        assertEq(
            launchCount, handler.launcher().lens().reservationCount(sid), "launchCount != reservationCount"
        );
    }

    /// @notice Spec §4.6.1 invariant — `seasonTickers[seasonId]` is injective. The ghost
    ///         registry is built only on successful reservations; each entry must agree
    ///         with the on-chain mapping AND no two ghost entries share a hash.
    function invariant_tickerUniqueness() public view {
        uint256 sid = handler.SEASON_ID();
        uint256 n = handler.ghostTickerCount();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 h = handler.ghostTickerHashes(i);
            address recordedCreator = handler.launcher().seasonTickers(sid, h);
            address ghostCreator = handler.ghostTickerToCreator(h);
            assertEq(recordedCreator, ghostCreator, "seasonTickers != ghost");
            // No duplicates: every prior entry j < i must have a distinct hash. Quadratic but
            // n ≤ 12 by construction (MAX_LAUNCHES).
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(handler.ghostTickerHashes(j) != h, "duplicate tickerHash in season");
            }
        }
    }

    // ============================================================ Filter Club (Epic 2.6)

    /// @notice Spec §47.3.8 credit conservation — every credit is exactly one of: still on a
    ///         pass (`creditsOf`), or spent into a not-yet-reclaimed reservation record. The
    ///         handler's ghost counters carry the consumed/reclaimed tallies; the on-chain
    ///         side is summed over every minted tokenId (no burn path, ids are 1..totalMinted).
    function invariant_creditConservation() public view {
        FilterClubPass pass = handler.clubPass();
        uint256 minted = pass.totalMinted();
        uint256 onPasses;
        for (uint256 t = 1; t <= minted; ++t) {
            onPasses += pass.creditsOf(t);
        }
        uint256 outstanding = handler.ghostCreditsConsumed() - handler.ghostCreditsReclaimed();
        assertEq(
            onPasses + outstanding, minted * uint256(pass.CREDITS_PER_TOKEN()), "credit conservation violated"
        );
    }

    /// @notice The pass pushes mint proceeds per-mint and moves no ETH anywhere else — its
    ///         balance is invariantly zero.
    function invariant_passHoldsNoEth() public view {
        assertEq(address(handler.clubPass()).balance, 0, "pass accumulated ETH");
    }

    /// @notice The immutable supply promise: no action sequence mints past `maxSupply`.
    function invariant_passSupplyCapped() public view {
        FilterClubPass pass = handler.clubPass();
        assertLe(pass.totalMinted(), pass.maxSupply(), "minted past maxSupply");
    }

    /// @notice Escrow solvency with zero-amount reservations in play: the contract's ETH
    ///         balance equals the sum of live reservation amounts (not yet released to deploy
    ///         nor refunded) plus any pending pull-pattern refund credits. Credit reservations
    ///         are first-class zero-amount rows — they must flow through reserve/release/
    ///         refund without ever skewing the ETH accounting.
    function invariant_escrowBalanceMatchesOutstanding() public view {
        uint256 sid = handler.SEASON_ID();
        LaunchEscrow escrow = handler.escrow();
        uint256 outstanding;
        uint256 n = handler.ghostReserverCount();
        // ghostReservers entries are unique per creator (per-wallet cap: one successful
        // reserve per creator per season), so a straight sum can't double-count.
        for (uint256 i = 0; i < n; ++i) {
            address creator = handler.ghostReservers(i);
            LaunchEscrow.Reservation memory r = escrow.escrowOf(sid, creator);
            if (!r.released && !r.refunded) {
                outstanding += uint256(r.amount);
            }
            outstanding += uint256(escrow.pendingRefunds(sid, creator));
        }
        assertEq(address(escrow).balance, outstanding, "escrow balance != live escrows + pending");
    }

    /// @notice Stub for the RefundFailed carve-out. Currently every creator in the handler
    ///         pool is an EOA so refunds always succeed; if the handler is later extended
    ///         with smart-wallet creators, this can route to the per-creator failure check.
    function _refundFailedFor(address) internal pure returns (bool) {
        return false;
    }
}
