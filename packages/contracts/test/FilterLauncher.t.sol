// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../src/FilterLauncher.sol";
import {LaunchEscrow} from "../src/LaunchEscrow.sol";
import {LauncherStakeAdmin} from "../src/LauncherStakeAdmin.sol";
import {IFilterFactory} from "../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";
import {IBonusFunding, IPOLManager} from "../src/SeasonVault.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockFilterFactory} from "./mocks/MockFilterFactory.sol";

/// @title FilterLauncherTest
/// @notice Coverage of the deferred-activation reservation flow (spec §46) on the launcher
///         contract. Replaces the pre-§46 `launchToken`-immediate-deploy suite with the
///         reservation-then-activate semantics.
contract FilterLauncherTest is Test {
    FilterLauncher launcher;
    MockFilterFactory factory;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polManager = address(0xF000);

    address aliceCreator = address(0xA1);
    address bobCreator = address(0xB1);

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

        vm.deal(aliceCreator, 100 ether);
        vm.deal(bobCreator, 100 ether);
        for (uint160 i = 1; i <= 12; ++i) {
            vm.deal(address(uint160(0x1000) + i), 100 ether);
        }
    }

    function _openSeason() internal returns (uint256 sid) {
        vm.prank(oracle);
        sid = launcher.startSeason();
    }

    /// @dev Pure mirror of the launcher's `_slotCost` so callers can compute slot costs
    ///      without dispatching a view call (which would consume a `vm.prank`).
    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether;
        uint256 m = 12;
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    /// @dev Wallet generator, used to satisfy the per-wallet reservation cap by spinning up
    ///      a fresh creator for each slot.
    function _wallet(uint256 idx) internal returns (address w) {
        w = address(uint160(0x1000) + uint160(idx));
        if (w.balance < 1 ether) vm.deal(w, 100 ether);
    }

    /// @dev Reserve a slot for `creator` with auto-derived ticker `T<idx>`. Returns the
    ///      slotIndex assigned (matches reservationCount pre-increment).
    function _reserve(address creator, uint64 idx) internal returns (uint64) {
        uint256 cost = _slotCost(idx);
        vm.prank(creator);
        launcher.reserve{value: cost}(_str(idx + 1), "ipfs://meta");
        return idx;
    }

    // ============================================================ Pre-activation reservations

    function test_StartSeason() public {
        uint256 sid = _openSeason();
        assertEq(sid, 1);
        assertEq(uint8(launcher.phaseOf(sid)), uint8(IFilterLauncher.Phase.Launch));
        assertEq(launcher.launchEndTime(sid), block.timestamp + 48 hours);
        assertEq(launcher.activated(sid), false, "fresh season not activated");
        assertEq(launcher.aborted(sid), false, "fresh season not aborted");
        assertEq(launcher.lens().reservationCount(sid), 0, "no reservations yet");
    }

    function test_FirstReservationEscrowsButDoesNotDeploy() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.prank(aliceCreator);
        launcher.reserve{value: cost}("PEPE", "ipfs://pepe");

        assertEq(launcher.lens().reservationCount(1), 1);
        assertEq(launcher.launchCount(1), 0, "no token deployed pre-activation");
        assertEq(launcher.activated(1), false);
        // Escrow holds the cost.
        assertEq(address(launcher.launchEscrow()).balance, cost);
        // Pending queue records the strings for activation-time deploy.
        FilterLauncher.PendingReservation[] memory pending = launcher.pendingReservations(1);
        assertEq(pending.length, 1);
        assertEq(pending[0].creator, aliceCreator);
        assertEq(pending[0].ticker, "PEPE");
        assertEq(pending[0].slotIndex, 0);
    }

    function test_FourthReservationActivatesAndBatchDeploys() public {
        _openSeason();

        // 1..3: escrow only.
        for (uint64 i = 0; i < 3; ++i) {
            address creator = _wallet(i);
            uint256 cost = _slotCost(i);
            vm.prank(creator);
            launcher.reserve{value: cost}(_str(i + 1), "ipfs://meta");
            assertEq(launcher.activated(1), false, "activation premature");
        }
        assertEq(launcher.launchCount(1), 0, "no deploys pre-threshold");

        // 4th reservation triggers activation and deploys all 4.
        address fourth = _wallet(3);
        uint256 cost4 = _slotCost(3);
        vm.prank(fourth);
        launcher.reserve{value: cost4}(_str(4), "ipfs://meta");

        assertEq(launcher.activated(1), true, "activated");
        assertEq(launcher.activatedAt(1), uint64(block.timestamp), "activatedAt stamped");
        assertEq(launcher.launchCount(1), 4, "all 4 deployed atomically");
        assertEq(launcher.lens().reservationCount(1), 4);
        // Pending queue cleared.
        assertEq(launcher.pendingReservations(1).length, 0);
        // Escrow balance: post-release the stake admin holds the funds (refundableStakeEnabled=true).
        assertEq(address(launcher.launchEscrow()).balance, 0, "escrow drained");
        assertEq(
            address(launcher.stakeAdmin()).balance,
            _slotCost(0) + _slotCost(1) + _slotCost(2) + _slotCost(3),
            "stake admin holds stakes"
        );
    }

    function test_PostActivationReservationDeploysImmediately() public {
        _openSeason();
        // Cross threshold.
        for (uint64 i = 0; i < 4; ++i) {
            _reserve(_wallet(i), i);
        }
        assertEq(launcher.launchCount(1), 4);

        // Slot 5 (post-activation) deploys in the same tx.
        address fifth = _wallet(4);
        uint256 cost = _slotCost(4);
        vm.prank(fifth);
        launcher.reserve{value: cost}("FIVE", "ipfs://5");

        assertEq(launcher.launchCount(1), 5);
        assertEq(launcher.lens().reservationCount(1), 5);
        // No pending entry should ever land post-activation.
        assertEq(launcher.pendingReservations(1).length, 0);
    }

    function test_FullCohortOfTwelve() public {
        _openSeason();
        for (uint64 i = 0; i < 12; ++i) {
            _reserve(_wallet(i), i);
        }
        assertEq(launcher.launchCount(1), 12);
        assertEq(launcher.lens().reservationCount(1), 12);
        // 13th reservation reverts SlotsExhausted.
        address thirteenth = makeAddr("thirteenth");
        vm.deal(thirteenth, 1 ether);
        vm.prank(thirteenth);
        vm.expectRevert(FilterLauncher.SlotsExhausted.selector);
        launcher.reserve{value: 1 ether}("THIRT", "ipfs://x");
    }

    function test_LaunchClosedFiresAtCapFill() public {
        _openSeason();
        for (uint64 i = 0; i < 11; ++i) {
            _reserve(_wallet(i), i);
        }
        // 12th reservation triggers LaunchClosed.
        address twelfth = _wallet(11);
        uint256 cost = _slotCost(11);
        vm.expectEmit(true, false, false, true);
        emit FilterLauncher.LaunchClosed(1, 12);
        vm.prank(twelfth);
        launcher.reserve{value: cost}(_str(12), "ipfs://meta");
    }

    // ============================================================ 8-step validation

    function test_RevertWhenWindowClosed() public {
        _openSeason();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.WindowClosed.selector);
        launcher.reserve{value: _slotCost(0)}("PEPE", "ipfs://meta");
    }

    function test_RevertWhenAlreadyReserved() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("PEPE", "ipfs://meta");
        // Second reservation from same wallet reverts.
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.AlreadyReserved.selector);
        launcher.reserve{value: _slotCost(1)}("WOJAK", "ipfs://meta");
    }

    function test_RevertWhenTickerBlocklisted() public {
        _openSeason();
        bytes32 filterHash = keccak256("FILTER");
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.TickerBlocklisted.selector);
        launcher.reserve{value: _slotCost(0)}("FILTER", "ipfs://meta");
    }

    function test_RevertWhenTickerTakenInSameSeason() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("PEPE", "ipfs://meta");
        bytes32 pepeHash = keccak256("PEPE");
        vm.prank(bobCreator);
        vm.expectRevert(FilterLauncher.TickerTaken.selector);
        launcher.reserve{value: _slotCost(1)}("$pepe", "ipfs://meta");
    }

    function test_RevertWhenInsufficientEscrow() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.InsufficientEscrow.selector);
        launcher.reserve{value: cost - 1}("PEPE", "ipfs://meta");
    }

    function test_ExcessValueRefundedAtReserve() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        uint256 balBefore = aliceCreator.balance;
        vm.prank(aliceCreator);
        launcher.reserve{value: cost + 1 ether}("PEPE", "ipfs://meta");
        // Excess ether goes back to the caller; only `cost` lands in escrow.
        assertEq(aliceCreator.balance, balBefore - cost, "excess refunded immediately");
        assertEq(address(launcher.launchEscrow()).balance, cost, "escrow holds exactly cost");
    }

    // ============================================================ Ticker normalisation

    function test_TickerNormalisationCanonicalisesSymbol() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("$pepe", "ipfs://meta");
        // Normalised hash matches `keccak256("PEPE")`.
        assertEq(launcher.seasonTickers(1, keccak256("PEPE")), aliceCreator);
        // Pending queue stores canonical form for deploy.
        FilterLauncher.PendingReservation[] memory pending = launcher.pendingReservations(1);
        assertEq(pending[0].ticker, "PEPE");
    }

    function test_TickerInvalidFormatReverts() public {
        _openSeason();
        // Leading-`$`-only is too short post-strip.
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.reserve{value: _slotCost(0)}("$X", "ipfs://meta");
    }

    // ============================================================ Abort path

    function test_AbortRefundsAllReservations() public {
        _openSeason();
        // Three reservations land — short of the activation threshold.
        for (uint64 i = 0; i < 3; ++i) {
            _reserve(_wallet(i), i);
        }
        uint256 escrowBefore = address(launcher.launchEscrow()).balance;
        assertEq(launcher.activated(1), false);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(1);

        assertEq(launcher.aborted(1), true);
        assertEq(address(launcher.launchEscrow()).balance, 0, "escrow drained");
        // Each creator received their original slot cost.
        for (uint64 i = 0; i < 3; ++i) {
            address creator = _wallet(i);
            // 100 ether starting balance; each paid _slotCost(i); refund returned _slotCost(i).
            assertEq(creator.balance, 100 ether, "creator made whole");
        }
        // Sanity on the SeasonAborted event payload.
        assertEq(escrowBefore, _slotCost(0) + _slotCost(1) + _slotCost(2));
    }

    function test_AbortRevertsWhileWindowOpen() public {
        _openSeason();
        _reserve(aliceCreator, 0);
        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.WindowStillOpen.selector);
        launcher.abortSeason(1);
    }

    function test_AbortRevertsAfterActivation() public {
        _openSeason();
        for (uint64 i = 0; i < 4; ++i) {
            _reserve(_wallet(i), i);
        }
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.SeasonAlreadyActivated.selector);
        launcher.abortSeason(1);
    }

    function test_NoReservationsAtH48AbortIsZeroReservationSweep() public {
        _openSeason();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(1);
        assertEq(launcher.aborted(1), true);
    }

    // ============================================================ Protocol launch

    function test_ProtocolLaunchBypassesReservation() public {
        _openSeason();
        (address token, address locker) =
            launcher.launchProtocolToken("filter.fun", "FILTER", "ipfs://filter");
        IFilterLauncher.TokenEntry memory e = launcher.entryOf(1, token);
        assertEq(e.isProtocolLaunched, true);
        assertTrue(locker != address(0));
        // Protocol launch does NOT count toward reservationCount or launchCount.
        assertEq(launcher.launchCount(1), 0);
        assertEq(launcher.lens().reservationCount(1), 0);
    }

    function test_ProtocolLaunchAfterActivationStillWorks() public {
        _openSeason();
        for (uint64 i = 0; i < 4; ++i) {
            _reserve(_wallet(i), i);
        }
        // After activation, owner can still seed a protocol token.
        (address proto,) = launcher.launchProtocolToken("filter.fun", "FILTERX", "ipfs://x");
        assertEq(launcher.entryOf(1, proto).isProtocolLaunched, true);
    }

    function test_NonOwnerCannotProtocolLaunch() public {
        _openSeason();
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.launchProtocolToken("X", "XXX", "");
    }

    // ============================================================ Pricing

    function test_DynamicPricingMonotonic() public view {
        uint256 prev = launcher.lens().launchCost(0);
        for (uint64 i = 1; i < 12; ++i) {
            uint256 c = launcher.lens().launchCost(i);
            assertGt(c, prev, "cost must strictly increase per slot");
            prev = c;
        }
    }

    function test_ExpectedSurvivorCount() public view {
        // Spec §46 cuts: bottom 50% rounded DOWN; top ⌈n/2⌉ survive.
        assertEq(launcher.lens().expectedSurvivorCount(4), 2);
        assertEq(launcher.lens().expectedSurvivorCount(5), 3);
        assertEq(launcher.lens().expectedSurvivorCount(7), 4);
        assertEq(launcher.lens().expectedSurvivorCount(8), 4);
        assertEq(launcher.lens().expectedSurvivorCount(11), 6);
        assertEq(launcher.lens().expectedSurvivorCount(12), 6);
    }

    // ============================================================ Phase transitions / pause

    function test_AdvancePhaseRequiresActivationOrAbort() public {
        uint256 sid = _openSeason();
        // No reservations at all — advancePhase out of Launch must revert.
        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.SeasonNotActivated.selector);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);
    }

    function test_AdvancePhaseAllowedAfterActivation() public {
        uint256 sid = _openSeason();
        for (uint64 i = 0; i < 4; ++i) {
            _reserve(_wallet(i), i);
        }
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);
        assertEq(uint8(launcher.phaseOf(sid)), uint8(IFilterLauncher.Phase.Filter));
    }

    function test_PauseBlocksReserve() public {
        _openSeason();
        launcher.setPaused(true);
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.reserve{value: _slotCost(0)}("PEPE", "ipfs://meta");
        launcher.setPaused(false);
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("PEPE", "ipfs://meta");
    }

    function test_CanReserveView() public {
        assertEq(launcher.lens().canReserve(), false, "no season open");
        _openSeason();
        assertEq(launcher.lens().canReserve(), true);
        launcher.setPaused(true);
        assertEq(launcher.lens().canReserve(), false, "paused");
        launcher.setPaused(false);
        vm.warp(block.timestamp + 48 hours);
        assertEq(launcher.lens().canReserve(), false, "window expired");
    }

    // ============================================================ Soft-filter (post-activation)

    function test_StakeRefundedOnSurvival() public {
        _openSeason();
        for (uint64 i = 0; i < 4; ++i) {
            _reserve(_wallet(i), i);
        }
        address[] memory tokens = launcher.tokensInSeason(1);
        assertEq(tokens.length, 4, "4 tokens deployed");

        vm.prank(oracle);
        launcher.advancePhase(1, IFilterLauncher.Phase.Filter);

        address creator0 = _wallet(0);
        uint256 balBefore = creator0.balance;
        address[] memory survivors = new address[](1);
        survivors[0] = tokens[0];
        address[] memory forfeited = new address[](0);

        // Cache the stakeAdmin reference so `vm.prank` lands on `applySoftFilter`, not on
        // the `launcher.stakeAdmin()` view call (vm.prank only persists for one external call).
        LauncherStakeAdmin admin = launcher.stakeAdmin();
        vm.prank(oracle);
        admin.applySoftFilter(1, survivors, forfeited);

        assertEq(creator0.balance, balBefore + _slotCost(0), "stake refunded");
        IFilterLauncher.LaunchInfo memory info = launcher.launchInfoOf(1, tokens[0]);
        assertEq(info.refunded, true);
        assertEq(info.stakeAmount, 0);
    }

    // ---------- helpers ----------

    function _str(uint64 i) internal pure returns (string memory) {
        // 1..12 → "T1".."T12" — short, unique, all-caps.
        if (i < 10) return string(abi.encodePacked("T", bytes1(uint8(48 + i))));
        return string(abi.encodePacked("T", bytes1(uint8(48 + i / 10)), bytes1(uint8(48 + (i % 10)))));
    }
}
