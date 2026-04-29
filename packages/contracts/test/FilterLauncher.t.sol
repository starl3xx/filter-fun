// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../src/FilterLauncher.sol";
import {IFilterFactory} from "../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";
import {IBonusFunding} from "../src/SeasonVault.sol";
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
    address polVault = address(0xF000);

    address aliceCreator = address(0xA1);

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, polVault, IBonusFunding(address(bonus)), address(weth)
        );
        factory = new MockFilterFactory(address(launcher), address(weth));
        launcher.setFactory(IFilterFactory(address(factory)));
    }

    function _openSeason() internal returns (uint256 sid) {
        vm.prank(oracle);
        sid = launcher.startSeason();
    }

    function test_StartSeasonAndLaunch() public {
        uint256 sid = _openSeason();
        assertEq(sid, 1);
        assertEq(uint8(launcher.phaseOf(sid)), uint8(IFilterLauncher.Phase.Launch));

        vm.prank(aliceCreator);
        (address token, address locker) = launcher.launch("Pepe", "PEPE", "ipfs://x");
        assertTrue(token != address(0));
        assertTrue(locker != address(0));

        IFilterLauncher.TokenEntry memory e = launcher.entryOf(sid, token);
        assertEq(e.creator, aliceCreator);
        assertEq(e.feeSplitter, locker);
        assertEq(e.isProtocolLaunched, false);
        assertEq(launcher.lockerOf(sid, token), locker);
    }

    function test_LaunchCapEnforced() public {
        _openSeason();
        vm.startPrank(aliceCreator);
        launcher.launch("A", "A", "");
        launcher.launch("B", "B", "");
        vm.expectRevert(FilterLauncher.LaunchCapReached.selector);
        launcher.launch("C", "C", "");
        vm.stopPrank();
    }

    function test_ProtocolLaunchBypassesCap() public {
        _openSeason();

        // Owner launches FILTER as protocol token.
        (address token, address locker) =
            launcher.launchProtocolToken("filter.fun", "FILTER", "ipfs://filter");
        IFilterLauncher.TokenEntry memory e = launcher.entryOf(1, token);
        assertEq(e.isProtocolLaunched, true);
        assertTrue(locker != address(0));

        // Owner can also launch user-style tokens; cap counts protocol launches separately
        // by creator, so the owner can still hit the cap with regular launches. Verify owner
        // hasn't been credited a regular launch by the protocol path.
        assertEq(launcher.launchesByWallet(1, owner), 0);
    }

    function test_NonOwnerCannotProtocolLaunch() public {
        _openSeason();
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.launchProtocolToken("X", "X", "");
    }

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

    function test_SkippingPhaseReverts() public {
        uint256 sid = _openSeason();
        vm.prank(oracle);
        vm.expectRevert(bytes("bad transition"));
        launcher.advancePhase(sid, IFilterLauncher.Phase.Settlement); // skip Filter+Finals
    }

    function test_LaunchOutsidePhaseReverts() public {
        uint256 sid = _openSeason();
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.WrongPhase.selector);
        launcher.launch("X", "X", "");
    }

    function test_SetFinalists() public {
        uint256 sid = _openSeason();
        vm.prank(aliceCreator);
        (address token,) = launcher.launch("A", "A", "");
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
        launcher.launch("A", "A", "");
        launcher.unpause();
        vm.prank(aliceCreator);
        launcher.launch("A", "A", "");
    }
}
