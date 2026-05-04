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

/// @title DeferredActivationE2ETest
/// @notice Spec §46 acceptance suite covering each of the cohort-size scenarios called out
///         in the epic ticket: N=0..3 abort, N=4 atomic batch deploy at threshold, N=5..12
///         post-activation deploys, N=12 cap fill. Each test stands up a fresh launcher +
///         escrow and walks the full reservation → activation/abort sequence.
contract DeferredActivationE2ETest is Test {
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

    // ============================================================ Helpers

    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether;
        uint256 m = 12;
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    function _openSeason() internal returns (uint256 sid) {
        vm.prank(oracle);
        sid = launcher.startSeason();
    }

    function _wallet(uint256 idx) internal returns (address w) {
        w = address(uint160(0xE2E00000) + uint160(idx));
        if (w.balance == 0) vm.deal(w, 100 ether);
    }

    function _ticker(uint256 idx) internal pure returns (string memory) {
        // E2E1, E2E2, ... E2E12 — within `^[A-Z0-9]{2,10}$` for any idx ≤ 99.
        if (idx < 10) {
            return string(abi.encodePacked("E2E", bytes1(uint8(48 + idx))));
        }
        return string(abi.encodePacked("E2E", bytes1(uint8(48 + idx / 10)), bytes1(uint8(48 + (idx % 10)))));
    }

    /// @dev Reserve `n` distinct creators into the current season, each in slot 0..n-1.
    function _reserveN(uint256 n) internal {
        uint256[] memory costs = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            costs[i] = _slotCost(uint64(i));
        }
        for (uint256 i = 0; i < n; ++i) {
            address w = _wallet(i);
            vm.prank(w);
            launcher.reserve{value: costs[i]}(_ticker(i + 1), "ipfs://m");
        }
    }

    // ============================================================ N=0..3 abort

    function test_NZero_AbortsSilently() public {
        uint256 sid = _openSeason();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);
        assertEq(launcher.aborted(sid), true);
        assertEq(launcher.activated(sid), false);
        assertEq(launcher.launchCount(sid), 0);
    }

    function test_NOne_AbortsRefundingTheOne() public {
        uint256 sid = _openSeason();
        _reserveN(1);
        uint256 escrowBefore = address(escrow).balance;
        assertEq(escrowBefore, _slotCost(0));

        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);

        assertEq(launcher.aborted(sid), true);
        assertEq(address(escrow).balance, 0);
        assertEq(_wallet(0).balance, 100 ether, "creator made whole");
    }

    function test_NTwo_Aborts() public {
        uint256 sid = _openSeason();
        _reserveN(2);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);
        assertEq(launcher.aborted(sid), true);
        assertEq(_wallet(0).balance, 100 ether);
        assertEq(_wallet(1).balance, 100 ether);
    }

    function test_NThree_AbortsJustBelowThreshold() public {
        uint256 sid = _openSeason();
        _reserveN(3);
        // Activation threshold is 4 — three reservations are NOT enough.
        assertEq(launcher.activated(sid), false);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);
        assertEq(launcher.aborted(sid), true);
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(_wallet(i).balance, 100 ether, "creator refunded");
        }
    }

    // ============================================================ N=4 activation

    function test_NFour_ActivatesAtomicBatchDeploy() public {
        uint256 sid = _openSeason();
        _reserveN(4);
        // All four deployed in the SAME tx as the 4th reservation.
        assertEq(launcher.activated(sid), true);
        assertEq(launcher.launchCount(sid), 4);
        assertEq(launcher.activatedAt(sid), uint64(block.timestamp));
        // Pending queue drained.
        assertEq(launcher.pendingReservations(sid).length, 0);
        // Escrow drained — funds released to launcher (refundable stake mode default).
        assertEq(address(escrow).balance, 0);
    }

    // ============================================================ N=5..11 post-activation

    function test_NFive_DeploysSlotFiveOnEntry() public {
        uint256 sid = _openSeason();
        _reserveN(5);
        assertEq(launcher.launchCount(sid), 5);
        assertEq(launcher.lens().reservationCount(sid), 5);
    }

    function test_NSeven_PartialMidCohort() public {
        uint256 sid = _openSeason();
        _reserveN(7);
        assertEq(launcher.launchCount(sid), 7);
    }

    function test_NEight_HalfCohort() public {
        uint256 sid = _openSeason();
        _reserveN(8);
        assertEq(launcher.launchCount(sid), 8);
        // Spec §46 cut math: 8 → ⌈8/2⌉ = 4 survivors.
        assertEq(launcher.lens().expectedSurvivorCount(8), 4);
    }

    function test_NEleven_Almost() public {
        uint256 sid = _openSeason();
        _reserveN(11);
        assertEq(launcher.launchCount(sid), 11);
        // 12th slot still open.
        address last = _wallet(11);
        vm.prank(last);
        launcher.reserve{value: _slotCost(11)}(_ticker(12), "ipfs://m");
        assertEq(launcher.launchCount(sid), 12);
    }

    // ============================================================ N=12 full cohort

    function test_NTwelve_FullCohortAndCapFill() public {
        uint256 sid = _openSeason();
        _reserveN(12);
        assertEq(launcher.launchCount(sid), 12);
        assertEq(launcher.lens().reservationCount(sid), 12);
        // 13th would revert SlotsExhausted.
        address overflow = makeAddr("overflow");
        vm.deal(overflow, 1 ether);
        vm.prank(overflow);
        vm.expectRevert(FilterLauncher.SlotsExhausted.selector);
        launcher.reserve{value: 1 ether}("LATE13", "ipfs://m");
    }
}
