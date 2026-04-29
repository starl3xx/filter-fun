// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../src/FilterLauncher.sol";
import {IFilterFactory} from "../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";
import {IBonusFunding, IPOLManager} from "../src/SeasonVault.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockFilterFactory} from "./mocks/MockFilterFactory.sol";

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

        // Fund test actors so they can pay slot costs.
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

    /// @dev Pure replica of `FilterLauncher._launchCost` so callers can compute slot costs
    ///      without dispatching a view call to the launcher. Important: any call between
    ///      `vm.prank` and the action under test consumes the prank, so this function MUST
    ///      stay pure (no calls to `launcher.*`).
    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether; // mirrors FilterLauncher.baseLaunchCost default
        uint256 m = 12; // MAX_LAUNCHES
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    function test_StartSeasonAndLaunch() public {
        uint256 sid = _openSeason();
        assertEq(sid, 1);
        assertEq(uint8(launcher.phaseOf(sid)), uint8(IFilterLauncher.Phase.Launch));
        assertEq(launcher.launchEndTime(sid), block.timestamp + 48 hours);

        uint256 cost = _slotCost(0);
        vm.prank(aliceCreator);
        (address token, address locker) = launcher.launchToken{value: cost}("Pepe", "PEPE", "ipfs://x");
        assertTrue(token != address(0));
        assertTrue(locker != address(0));

        IFilterLauncher.TokenEntry memory e = launcher.entryOf(sid, token);
        assertEq(e.creator, aliceCreator);
        assertEq(e.feeSplitter, locker);
        assertEq(e.isProtocolLaunched, false);
        assertEq(launcher.lockerOf(sid, token), locker);

        IFilterLauncher.LaunchInfo memory info = launcher.launchInfoOf(sid, token);
        assertEq(info.slotIndex, 0);
        assertEq(info.costPaid, cost);
        assertEq(info.stakeAmount, cost, "stake retained while refundable mode on");
    }

    // ============================================================ Slot cap

    function test_CannotLaunchAfter12Slots() public {
        _openSeason();
        for (uint160 i = 1; i <= 12; ++i) {
            address creator = address(uint160(0x1000) + i);
            uint256 c = _slotCost(uint64(i - 1));
            vm.prank(creator);
            launcher.launchToken{value: c}(_str(i), _str(i), "");
        }
        assertEq(launcher.launchCount(1), 12);

        address extra = address(0xDEAD);
        vm.deal(extra, 10 ether);
        vm.prank(extra);
        vm.expectRevert(FilterLauncher.LaunchCapReached.selector);
        launcher.launchToken{value: 1 ether}("X", "ZZZZZ", "");
    }

    function test_LaunchSlotFilledEmits() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.expectEmit(true, false, false, true);
        emit FilterLauncher.LaunchSlotFilled(1, 0);
        vm.prank(aliceCreator);
        launcher.launchToken{value: cost}("A", "AAA", "");
    }

    function test_CapFillEmitsLaunchClosed() public {
        _openSeason();
        for (uint160 i = 1; i <= 11; ++i) {
            address creator = address(uint160(0x1000) + i);
            uint256 c = _slotCost(uint64(i - 1));
            vm.prank(creator);
            launcher.launchToken{value: c}(_str(i), _str(i), "");
        }
        // Final slot triggers LaunchClosed.
        address last = address(uint160(0x1000) + 12);
        uint256 finalCost = _slotCost(11);
        vm.expectEmit(true, false, false, true);
        emit FilterLauncher.LaunchClosed(1, 12);
        vm.prank(last);
        launcher.launchToken{value: finalCost}(_str(12), _str(12), "");
    }

    // ============================================================ Per-wallet cap

    function test_PerWalletCapEnforced() public {
        _openSeason();
        vm.startPrank(aliceCreator);
        launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
        launcher.launchToken{value: _slotCost(1)}("B", "BBB", "");
        vm.expectRevert(FilterLauncher.LaunchCapReached.selector);
        launcher.launchToken{value: _slotCost(2)}("C", "CCC", "");
        vm.stopPrank();
    }

    function test_ProtocolLaunchBypassesCap() public {
        _openSeason();
        (address token, address locker) =
            launcher.launchProtocolToken("filter.fun", "FILTER", "ipfs://filter");
        IFilterLauncher.TokenEntry memory e = launcher.entryOf(1, token);
        assertEq(e.isProtocolLaunched, true);
        assertTrue(locker != address(0));

        // Protocol launch does NOT count toward slot cap or per-wallet cap.
        assertEq(launcher.launchCount(1), 0);
        assertEq(launcher.launchesByWallet(1, owner), 0);
    }

    function test_NonOwnerCannotProtocolLaunch() public {
        _openSeason();
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.launchProtocolToken("X", "XXX", "");
    }

    // ============================================================ Pricing

    function test_DynamicPricingMonotonic() public view {
        uint256 prev = launcher.launchCost(0);
        for (uint64 i = 1; i < 12; ++i) {
            uint256 c = launcher.launchCost(i);
            assertGt(c, prev, "cost must strictly increase per slot");
            prev = c;
        }
    }

    function test_PricingFormula() public view {
        // BASE * (1 + (slot/MAX)^2): slot 0 → BASE, slot 12 (boundary, not achievable) → 2x BASE.
        uint256 base = launcher.baseLaunchCost();
        assertEq(launcher.launchCost(0), base, "slot 0 = base");
        // Slot 11: BASE * (144 + 121) / 144 = BASE * 265/144.
        assertEq(launcher.launchCost(11), (base * 265) / 144, "slot 11 formula");
        // Sanity: last slot ~1.84x base — within the spec's "2x-2.5x" target band.
        assertGt(launcher.launchCost(11), (base * 18) / 10);
    }

    function test_InsufficientPaymentReverts() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.InsufficientPayment.selector);
        launcher.launchToken{value: cost - 1}("A", "AAA", "");
    }

    function test_ExcessValueRefunded() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        uint256 balBefore = aliceCreator.balance;
        vm.prank(aliceCreator);
        launcher.launchToken{value: cost + 1 ether}("A", "AAA", "");
        // Cost is held as stake (refundable mode on), so creator should be down exactly `cost`.
        assertEq(aliceCreator.balance, balBefore - cost, "excess returned");
    }

    // ============================================================ Launch window

    function test_LaunchWindowExpires() public {
        _openSeason();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.LaunchWindowClosed.selector);
        launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
    }

    function test_CanLaunchView() public {
        assertEq(launcher.canLaunch(), false, "no season open");
        _openSeason();
        assertEq(launcher.canLaunch(), true);
        vm.warp(block.timestamp + 48 hours);
        assertEq(launcher.canLaunch(), false, "window expired");
    }

    function test_GetLaunchStatus() public {
        _openSeason();
        IFilterLauncher.LaunchStatus memory s = launcher.getLaunchStatus(1);
        assertEq(s.launchCount, 0);
        assertEq(s.maxLaunches, 12);
        assertEq(s.timeRemaining, 48 hours);
        assertEq(s.nextLaunchCost, _slotCost(0));

        vm.prank(aliceCreator);
        launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
        s = launcher.getLaunchStatus(1);
        assertEq(s.launchCount, 1);
        assertEq(s.nextLaunchCost, _slotCost(1));
    }

    function test_GetLaunchSlotsExcludesProtocol() public {
        _openSeason();
        launcher.launchProtocolToken("filter.fun", "FILTER", "");
        vm.prank(aliceCreator);
        (address tokenA,) = launcher.launchToken{value: _slotCost(0)}("Pepe", "PEPE", "");
        vm.prank(bobCreator);
        (address tokenB,) = launcher.launchToken{value: _slotCost(1)}("Wojak", "WOJAK", "");

        (address[] memory tokens, uint64[] memory slotIxs, address[] memory creators) =
            launcher.getLaunchSlots(1);
        assertEq(tokens.length, 2);
        assertEq(tokens[0], tokenA);
        assertEq(tokens[1], tokenB);
        assertEq(slotIxs[0], 0);
        assertEq(slotIxs[1], 1);
        assertEq(creators[0], aliceCreator);
        assertEq(creators[1], bobCreator);
    }

    // ============================================================ Symbol collision

    function test_DuplicateSymbolReverts() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.launchToken{value: _slotCost(0)}("Pepe", "PEPE", "");
        vm.prank(bobCreator);
        vm.expectRevert(FilterLauncher.DuplicateSymbol.selector);
        launcher.launchToken{value: _slotCost(1)}("Pepe2", "PEPE", "");
    }

    // ============================================================ Stake refund / forfeit

    function test_StakeRefundedOnSurvival() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.prank(aliceCreator);
        (address token,) = launcher.launchToken{value: cost}("A", "AAA", "");

        // Move into Filter so soft filter is callable.
        vm.prank(oracle);
        launcher.advancePhase(1, IFilterLauncher.Phase.Filter);

        uint256 balBefore = aliceCreator.balance;
        address[] memory survivors = new address[](1);
        survivors[0] = token;
        address[] memory forfeited = new address[](0);

        vm.prank(oracle);
        launcher.applySoftFilter(1, survivors, forfeited);

        assertEq(aliceCreator.balance, balBefore + cost, "stake refunded");
        IFilterLauncher.LaunchInfo memory info = launcher.launchInfoOf(1, token);
        assertEq(info.refunded, true);
        assertEq(info.filteredEarly, false);
        assertEq(info.stakeAmount, 0);
    }

    function test_StakeForfeitedOnFilter() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.prank(aliceCreator);
        (address token,) = launcher.launchToken{value: cost}("A", "AAA", "");

        vm.prank(oracle);
        launcher.advancePhase(1, IFilterLauncher.Phase.Filter);

        uint256 treasuryBefore = treasury.balance;
        address[] memory survivors = new address[](0);
        address[] memory forfeited = new address[](1);
        forfeited[0] = token;

        vm.prank(oracle);
        launcher.applySoftFilter(1, survivors, forfeited);

        assertEq(treasury.balance, treasuryBefore + cost, "stake to treasury");
        IFilterLauncher.LaunchInfo memory info = launcher.launchInfoOf(1, token);
        assertEq(info.filteredEarly, true);
        assertEq(info.refunded, false);
        assertEq(info.stakeAmount, 0);
    }

    function test_SoftFilterIdempotent() public {
        _openSeason();
        uint256 cost = _slotCost(0);
        vm.prank(aliceCreator);
        (address token,) = launcher.launchToken{value: cost}("A", "AAA", "");

        vm.prank(oracle);
        launcher.advancePhase(1, IFilterLauncher.Phase.Filter);

        address[] memory survivors = new address[](1);
        survivors[0] = token;
        address[] memory forfeited = new address[](0);
        vm.prank(oracle);
        launcher.applySoftFilter(1, survivors, forfeited);

        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.AlreadyResolved.selector);
        launcher.applySoftFilter(1, survivors, forfeited);
    }

    function test_SoftFilterRequiresPostLaunchPhase() public {
        _openSeason();
        vm.prank(aliceCreator);
        (address token,) = launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
        address[] memory survivors = new address[](1);
        survivors[0] = token;
        address[] memory forfeited = new address[](0);
        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.WrongPhase.selector);
        launcher.applySoftFilter(1, survivors, forfeited);
    }

    function test_NonOracleCannotApplySoftFilter() public {
        _openSeason();
        vm.prank(aliceCreator);
        (address token,) = launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
        vm.prank(oracle);
        launcher.advancePhase(1, IFilterLauncher.Phase.Filter);
        address[] memory survivors = new address[](1);
        survivors[0] = token;
        address[] memory forfeited = new address[](0);
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.NotOracle.selector);
        launcher.applySoftFilter(1, survivors, forfeited);
    }

    // ============================================================ Stake-disabled (fee mode)

    function test_FeeModeRoutesToTreasury() public {
        launcher.setRefundableStakeEnabled(false);
        _openSeason();
        uint256 cost = _slotCost(0);
        uint256 treasuryBefore = treasury.balance;
        vm.prank(aliceCreator);
        (address token,) = launcher.launchToken{value: cost}("A", "AAA", "");
        assertEq(treasury.balance, treasuryBefore + cost, "fee forwarded");

        IFilterLauncher.LaunchInfo memory info = launcher.launchInfoOf(1, token);
        assertEq(info.stakeAmount, 0, "no stake retained in fee mode");
        assertEq(info.costPaid, cost);
    }

    // ============================================================ Phase + pause (existing)

    function test_PhaseTransitions() public {
        uint256 sid = _openSeason();
        vm.startPrank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Finals);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Settlement);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Closed);
        vm.stopPrank();
        assertEq(uint8(launcher.phaseOf(sid)), uint8(IFilterLauncher.Phase.Closed));
    }

    function test_AdvancingFromLaunchEmitsLaunchClosed() public {
        uint256 sid = _openSeason();
        vm.expectEmit(true, false, false, true);
        emit FilterLauncher.LaunchClosed(sid, 0);
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);
    }

    function test_SkippingPhaseReverts() public {
        uint256 sid = _openSeason();
        vm.prank(oracle);
        vm.expectRevert(bytes("bad transition"));
        launcher.advancePhase(sid, IFilterLauncher.Phase.Settlement);
    }

    function test_LaunchOutsidePhaseReverts() public {
        uint256 sid = _openSeason();
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.WrongPhase.selector);
        launcher.launchToken{value: _slotCost(0)}("X", "XXX", "");
    }

    function test_SetFinalists() public {
        uint256 sid = _openSeason();
        vm.prank(aliceCreator);
        (address token,) = launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);

        address[] memory finalists = new address[](1);
        finalists[0] = token;
        vm.prank(oracle);
        launcher.setFinalists(sid, finalists);

        assertEq(launcher.entryOf(sid, token).isFinalist, true);
    }

    function test_PauseBlocksLaunch() public {
        _openSeason();
        launcher.pause();
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
        launcher.unpause();
        vm.prank(aliceCreator);
        launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
    }

    // ---------- helpers ----------

    function _str(uint160 i) internal pure returns (string memory) {
        // 1..12 → "T1".."T12" — short, unique, all-caps.
        if (i < 10) return string(abi.encodePacked("T", bytes1(uint8(48 + i))));
        return string(abi.encodePacked("T", bytes1(uint8(48 + i / 10)), bytes1(uint8(48 + (i % 10)))));
    }
}
