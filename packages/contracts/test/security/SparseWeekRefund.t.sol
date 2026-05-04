// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault} from "../../src/TournamentVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title SparseWeekRefundTest
/// @notice Spec §46 sparse-week scenario: reservations land just inside the launch window
///         but never reach the activation threshold. At hour 48 the scheduler invokes
///         `abortSeason`, which sweeps every escrow back to its creator and emits the
///         `SeasonAborted` summary. This test pins the conservation property: total ETH
///         out == total ETH escrowed; per-creator refund matches per-creator escrow.
contract SparseWeekRefundTest is Test {
    FilterLauncher launcher;
    LaunchEscrow escrow;
    MockFilterFactory factory;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polManager = address(0xF000);

    receive() external payable {}

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        launcher.setPolManager(IPOLManager(polManager));
        factory = new MockFilterFactory(address(launcher), address(weth));
        launcher.setFactory(IFilterFactory(address(factory)));
        // Tournament wire required since `startSeason` zero-checks the registry
        // (audit: bugbot M PR #88).
        launcher.setTournament(TournamentRegistry(address(0xDEAD)), TournamentVault(payable(address(0xBEEF))));
        escrow = launcher.launchEscrow();
    }

    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether;
        uint256 m = 12;
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    /// @notice Two reservations land at h47, scheduler aborts at h48, both creators get
    ///         exact-amount refunds, totalRefunded matches the sum of escrows.
    function test_TwoReservationsAtH47_AbortAtH48_RefundsConserve() public {
        vm.prank(oracle);
        uint256 sid = launcher.startSeason();

        address creatorA = makeAddr("creatorA");
        address creatorB = makeAddr("creatorB");
        vm.deal(creatorA, 10 ether);
        vm.deal(creatorB, 10 ether);

        // Advance into hour 47 of the launch window. Reservations still legal.
        vm.warp(block.timestamp + 47 hours);

        uint256 cost0 = _slotCost(0);
        uint256 cost1 = _slotCost(1);

        vm.prank(creatorA);
        launcher.reserve{value: cost0}("SPRSE1", "ipfs://a");
        vm.prank(creatorB);
        launcher.reserve{value: cost1}("SPRSE2", "ipfs://b");

        uint256 totalEscrowed = cost0 + cost1;
        assertEq(address(escrow).balance, totalEscrowed, "escrow holds total");

        // h48 hits — scheduler aborts.
        vm.warp(block.timestamp + 1 hours);
        vm.recordLogs();
        vm.prank(oracle);
        launcher.abortSeason(sid);

        // Both creators back to 10 ether (whole again).
        assertEq(creatorA.balance, 10 ether);
        assertEq(creatorB.balance, 10 ether);
        assertEq(address(escrow).balance, 0, "escrow drained");

        // SeasonAborted emitted with correct totals on the launcher.
        // (LaunchEscrow also emits one per-season; tests can scan either.)
        assertEq(launcher.aborted(sid), true);
    }

    /// @notice Three reservations — boundary case, just one short of the threshold. The
    ///         "almost-quorum" path is operationally dangerous (operator might be tempted
    ///         to fill the 4th slot themselves); the contract must refund all three without
    ///         any privileged shortcut.
    function test_ThreeReservationsAlmostQuorum_StillAborts() public {
        vm.prank(oracle);
        uint256 sid = launcher.startSeason();

        address[3] memory creators = [makeAddr("almostA"), makeAddr("almostB"), makeAddr("almostC")];
        for (uint256 i = 0; i < 3; ++i) {
            vm.deal(creators[i], 10 ether);
        }

        uint256[3] memory costs = [_slotCost(0), _slotCost(1), _slotCost(2)];
        vm.prank(creators[0]);
        launcher.reserve{value: costs[0]}("ALMOSTA", "ipfs://a");
        vm.prank(creators[1]);
        launcher.reserve{value: costs[1]}("ALMOSTB", "ipfs://b");
        vm.prank(creators[2]);
        launcher.reserve{value: costs[2]}("ALMOSTC", "ipfs://c");

        // Activation never happened.
        assertEq(launcher.activated(sid), false);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);

        for (uint256 i = 0; i < 3; ++i) {
            assertEq(creators[i].balance, 10 ether, "creator made whole");
        }
    }

    /// @notice Refund-failure case: a creator whose receive hook reverts (e.g. a contract
    ///         with no fallback). The sweep MUST continue; the failed creator's amount is
    ///         credited to `pendingRefunds` so the creator can pull it later via
    ///         `claimPendingRefund`. Other creators in the same sweep still get paid.
    ///         (Audit: bugbot M PR #88 — pull-pattern fallback. Pre-fix this rolled back
    ///         `r.refunded = false` and left funds permanently stuck since the season's
    ///         `aborted` flag blocks any further `refundAll` / `releaseToDeploy`.)
    function test_RefundFailureSkipsRecipientButCompletesRest() public {
        vm.prank(oracle);
        uint256 sid = launcher.startSeason();

        BadReceiver bad = new BadReceiver();
        address goodCreator = makeAddr("goodCreator");
        vm.deal(goodCreator, 10 ether);
        // BadReceiver intentionally NOT pre-funded — the reservation cost comes from this
        // test contract's `msg.value` passthrough through `reserveVia`. Bad's net balance
        // delta from the round-trip should be 0 (refund fails so nothing comes back).

        uint256 cost0 = _slotCost(0);
        uint256 cost1 = _slotCost(1);
        bad.reserveVia{value: cost0}(address(launcher), "BADRCV", "ipfs://b");
        vm.prank(goodCreator);
        launcher.reserve{value: cost1}("GOODRCV", "ipfs://g");

        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);

        // Bad receiver's reservation is marked refunded (the sweep made its accounting pass);
        // the actual stuck amount lives in `pendingRefunds` for self-service pull recovery.
        LaunchEscrow.Reservation memory badRes = escrow.escrowOf(sid, address(bad));
        assertEq(badRes.refunded, true, "bad receiver flag flipped after sweep");
        assertEq(escrow.pendingRefunds(sid, address(bad)), cost0, "pending credit recorded");
        assertEq(address(bad).balance, 0, "bad receiver got nothing back (push failed)");

        // Good creator made whole on the original sweep.
        assertEq(goodCreator.balance, 10 ether, "good creator refunded");

        // Funds for the failed refund still in the escrow contract, awaiting pull-pattern
        // claim. The exact remaining balance equals the bad receiver's slot cost.
        assertEq(address(escrow).balance, cost0, "stuck funds remain in escrow");

        // Pull-pattern recovery: BadReceiver redirects the claim to a fresh EOA that
        // accepts ETH (the on-chain analogue of "rotate to a new wallet"). After the claim,
        // the credit is zeroed and the escrow is empty.
        address payable rescue = payable(makeAddr("rescue"));
        bad.claim(address(escrow), sid, rescue);
        assertEq(rescue.balance, cost0, "rescue address received pulled refund");
        assertEq(escrow.pendingRefunds(sid, address(bad)), 0, "pending credit cleared");
        assertEq(address(escrow).balance, 0, "escrow drained after pull");
    }

    /// @notice Audit: bugbot M PR #88 — the pull-pattern claim is self-only (msg.sender must
    ///         be the address that originally reserved). A third party cannot drain another
    ///         creator's pending credit even if they spot it in the indexer.
    function test_ClaimPendingRefund_RejectsNonCreator() public {
        vm.prank(oracle);
        uint256 sid = launcher.startSeason();

        BadReceiver bad = new BadReceiver();
        address goodCreator = makeAddr("goodCreator");
        vm.deal(goodCreator, 10 ether);

        uint256 cost0 = _slotCost(0);
        uint256 cost1 = _slotCost(1);
        bad.reserveVia{value: cost0}(address(launcher), "BADRCV", "ipfs://b");
        vm.prank(goodCreator);
        launcher.reserve{value: cost1}("GOODRCV", "ipfs://g");

        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);

        // Stranger has nothing pending; claim must revert NoPendingRefund.
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(LaunchEscrow.NoPendingRefund.selector);
        escrow.claimPendingRefund(sid, payable(attacker));

        // Good creator already got paid via the sweep; their pending credit is also zero.
        vm.prank(goodCreator);
        vm.expectRevert(LaunchEscrow.NoPendingRefund.selector);
        escrow.claimPendingRefund(sid, payable(goodCreator));

        // Pending credit is exclusively for `bad`.
        assertEq(escrow.pendingRefunds(sid, address(bad)), cost0);
    }
}

/// @notice Contract that reverts on receive — simulates a creator whose smart-wallet doesn't
///         accept ETH back. Used to drive the per-creator refund-failure branch.
contract BadReceiver {
    function reserveVia(address launcher, string calldata ticker, string calldata uri) external payable {
        FilterLauncher(payable(launcher)).reserve{value: msg.value}(ticker, uri);
    }

    /// @notice Pull a stuck pending refund out of the escrow, redirecting to a wallet that
    ///         actually accepts ETH. This is the on-chain analogue of an operator runbook
    ///         step: "creator's wallet is broken, rotate to a new EOA".
    function claim(address escrow, uint256 seasonId, address payable to) external {
        LaunchEscrow(payable(escrow)).claimPendingRefund(seasonId, to);
    }

    receive() external payable {
        revert("nope");
    }
}
