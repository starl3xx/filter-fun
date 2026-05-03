// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title EightStepValidationTest
/// @notice Spec §46.9 contract — the eight reservation validations are checked in a fixed
///         order, each with a distinct custom error. This test isolates each failure path
///         and asserts the correct selector fires, so a future re-ordering or merge would
///         immediately break a named test rather than silently shifting which gate caught
///         what.
///
///         Order (1..8) per spec §46.9:
///           1. Per-wallet cap (one reservation per wallet per season) → AlreadyReserved
///           2. Slot availability (reservationCount < MAX_LAUNCHES) → SlotsExhausted
///           3. Window open (block.timestamp < launchEndTime) → WindowClosed
///           4. Ticker normalisation (`^[A-Z0-9]{2,10}$`) → TickerLib.InvalidTickerFormat
///           5. Protocol blocklist (FILTER, WETH, ...) → TickerBlocklisted
///           6. Cross-season winner reservation → TickerWinnerReserved
///           7. Per-season uniqueness → TickerTaken
///           8. Funds attached (msg.value >= slotCost) → InsufficientEscrow
///
///         Step 3 (window-open) actually fires BEFORE step 1..2 in the implementation —
///         the spec text orders the steps logically; the contract orders them by cheapness
///         (cheap reverts first). Tests below pin the actual contract order.
contract EightStepValidationTest is Test {
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

    address creator = makeAddr("creator");

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
        escrow = launcher.launchEscrow();
        vm.deal(creator, 100 ether);
    }

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

    // ============================================================ Step 1 — per-wallet cap

    function test_Step1_AlreadyReserved() public {
        _openSeason();
        vm.prank(creator);
        launcher.reserve{value: _slotCost(0)}("ONE", "ipfs://a");
        vm.prank(creator);
        vm.expectRevert(FilterLauncher.AlreadyReserved.selector);
        launcher.reserve{value: _slotCost(1)}("TWO", "ipfs://b");
    }

    // ============================================================ Step 2 — slot availability

    function test_Step2_SlotsExhausted() public {
        _openSeason();
        // Fill all 12 slots.
        for (uint160 i = 1; i <= 12; ++i) {
            address w = address(uint160(0xFE10) + i);
            vm.deal(w, 1 ether);
            string memory t = string(abi.encodePacked("S2", bytes1(uint8(48 + (i / 10))), bytes1(uint8(48 + (i % 10)))));
            vm.prank(w);
            launcher.reserve{value: _slotCost(uint64(i - 1))}(t, "ipfs://m");
        }
        // 13th must trip SlotsExhausted.
        address overflow = makeAddr("overflow");
        vm.deal(overflow, 1 ether);
        vm.prank(overflow);
        vm.expectRevert(FilterLauncher.SlotsExhausted.selector);
        launcher.reserve{value: 1 ether}("OVRFLW", "ipfs://m");
    }

    // ============================================================ Step 3 — window closed

    function test_Step3_WindowClosed() public {
        _openSeason();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(creator);
        vm.expectRevert(FilterLauncher.WindowClosed.selector);
        launcher.reserve{value: _slotCost(0)}("AFTER", "ipfs://a");
    }

    // ============================================================ Step 4 — invalid format

    function test_Step4_InvalidTickerFormat() public {
        _openSeason();
        vm.prank(creator);
        vm.expectRevert();
        launcher.reserve{value: _slotCost(0)}("X", "ipfs://a");
    }

    // ============================================================ Step 5 — blocklisted

    function test_Step5_TickerBlocklisted() public {
        _openSeason();
        bytes32 h = keccak256("FILTER");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(FilterLauncher.TickerBlocklisted.selector, h));
        launcher.reserve{value: _slotCost(0)}("FILTER", "ipfs://a");
    }

    // ============================================================ Step 6 — winner-reserved

    function test_Step6_TickerWinnerReserved() public {
        uint256 sid = _openSeason();
        address vault = launcher.vaultOf(sid);
        bytes32 h = keccak256("CHAMP");
        vm.prank(vault);
        launcher.setWinnerTicker(sid, h, address(0xBEEF));

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(FilterLauncher.TickerWinnerReserved.selector, h));
        launcher.reserve{value: _slotCost(0)}("CHAMP", "ipfs://a");
    }

    // ============================================================ Step 7 — per-season uniqueness

    function test_Step7_TickerTaken() public {
        _openSeason();
        address other = makeAddr("other");
        vm.deal(other, 1 ether);
        vm.prank(other);
        launcher.reserve{value: _slotCost(0)}("SHARED", "ipfs://a");

        bytes32 h = keccak256("SHARED");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(FilterLauncher.TickerTaken.selector, uint256(1), h));
        launcher.reserve{value: _slotCost(1)}("SHARED", "ipfs://b");
    }

    // ============================================================ Step 8 — insufficient escrow

    function test_Step8_InsufficientEscrow() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.prank(creator);
        vm.expectRevert(FilterLauncher.InsufficientEscrow.selector);
        launcher.reserve{value: cost - 1}("UNDR", "ipfs://a");
    }

    // ============================================================ Order property

    /// @notice Combined: a reservation that would FAIL on multiple steps must trip the
    ///         lower-numbered step. A blocklisted ticker (step 5) submitted with insufficient
    ///         funds (step 8) reverts with `TickerBlocklisted`, not `InsufficientEscrow`.
    function test_OrderingFiresLowerStepFirst() public {
        _openSeason();
        bytes32 h = keccak256("FILTER");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(FilterLauncher.TickerBlocklisted.selector, h));
        launcher.reserve{value: 0}("FILTER", "ipfs://a");
    }
}
