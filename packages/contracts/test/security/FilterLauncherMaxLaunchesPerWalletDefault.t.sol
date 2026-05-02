// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title FilterLauncherMaxLaunchesPerWalletDefaultTest -- Audit Finding C-2
/// @notice The Phase-1 audit (`audit/2026-05-PHASE-1-AUDIT/contracts.md` Critical #2)
///         flagged that `FilterLauncher.maxLaunchesPerWallet` was storage-initialized to `2`
///         while spec §4.6 (locked 2026-04-30) requires `1`. The deploy script
///         (`DeploySepolia.s.sol`) calls `setMaxLaunchesPerWallet(env(MAX_LAUNCHES_PER_WALLET))`
///         post-construction, which masks the wrong default whenever the env var is set
///         correctly -- but the existing `Deploy.t.sol` checks all run *after* that override,
///         so they never observed the raw constructor state. If the env var were ever missing,
///         mistyped, or the override step skipped on a future deploy path, the contract would
///         ship with a non-spec cap.
///
///         This suite locks the constructor default itself: it exercises the launcher
///         *without* running the deploy script, asserting both the storage default and the
///         on-chain enforcement layer behave per spec §4.6 directly out of the constructor.
///
///         Test outcome contract:
///           - Pre-fix: storage default is `2`, so `test_AuditC2_ConstructorDefaultMatchesSpecLock`
///             FAILS (expected 1, got 2) and `test_AuditC2_SecondLaunchSameWalletRevertsByDefault`
///             FAILS (the second launch succeeds instead of reverting).
///           - Post-fix: storage default is bound to `SPEC_LOCK_MAX_LAUNCHES_PER_WALLET = 1`, so
///             both tests PASS without any post-construction `setMaxLaunchesPerWallet` call.
contract FilterLauncherMaxLaunchesPerWalletDefaultTest is Test {
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

    receive() external payable {}

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);

        // Direct constructor — NO deploy-script override. This is the load-bearing
        // distinction: every prior test path called setMaxLaunchesPerWallet(1) post-construction.
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        launcher.setPolManager(IPOLManager(polManager));
        factory = new MockFilterFactory(address(launcher), address(weth));
        launcher.setFactory(IFilterFactory(address(factory)));

        vm.deal(aliceCreator, 100 ether);
    }

    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether;
        uint256 m = 12;
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    /// @notice Audit C-2: the constructor default for `maxLaunchesPerWallet` MUST equal the
    ///         spec §4.6 lock value. Pre-fix this returned `2`.
    function test_AuditC2_ConstructorDefaultMatchesSpecLock() public view {
        assertEq(
            launcher.SPEC_LOCK_MAX_LAUNCHES_PER_WALLET(),
            1,
            "spec lock constant drifted from spec 4.6 (1) -- update spec or constant"
        );
        assertEq(
            launcher.maxLaunchesPerWallet(),
            launcher.SPEC_LOCK_MAX_LAUNCHES_PER_WALLET(),
            "raw constructor default != spec lock -- deploy paths that skip setMaxLaunchesPerWallet ship a non-spec cap"
        );
    }

    /// @notice Audit C-2 functional layer: the on-chain cap check must reject a wallet's
    ///         second launch in the same season WITHOUT any post-construction governance
    ///         touch. Pre-fix the second launch went through because the default was `2`.
    function test_AuditC2_SecondLaunchSameWalletRevertsByDefault() public {
        vm.prank(oracle);
        launcher.startSeason();

        vm.startPrank(aliceCreator);
        launcher.launchToken{value: _slotCost(0)}("A", "AAA", "");
        vm.expectRevert(FilterLauncher.LaunchCapReached.selector);
        launcher.launchToken{value: _slotCost(1)}("B", "BBB", "");
        vm.stopPrank();
    }
}
