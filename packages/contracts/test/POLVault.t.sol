// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {POLVault} from "../src/POLVault.sol";

/// @notice Focused tests for POLVault's accounting model and POLManager auth gate.
///
///         The vault is read-mostly: it holds NO tokens (LP positions live in the per-token
///         FilterLpLocker), it just records the (winner, weth, tokens, liquidity) tuples for
///         indexer + UI visibility. The only mutator is `recordDeployment`, gated to the
///         registered POLManager via a one-shot setter.
contract POLVaultTest is Test {
    POLVault polVault;

    address owner = address(this);
    address polManager = makeAddr("polManager");
    address attacker = makeAddr("attacker");
    address winnerA = makeAddr("winnerA");
    address winnerB = makeAddr("winnerB");

    function setUp() public {
        polVault = new POLVault(owner);
        polVault.setPolManager(polManager);
    }

    // ============================================================ setPolManager

    function test_SetPolManager_OneShot() public {
        POLVault v = new POLVault(owner);
        v.setPolManager(polManager);
        vm.expectRevert(POLVault.PolManagerAlreadySet.selector);
        v.setPolManager(makeAddr("other"));
    }

    function test_SetPolManager_OnlyOwner() public {
        POLVault v = new POLVault(owner);
        vm.prank(attacker);
        vm.expectRevert();
        v.setPolManager(polManager);
    }

    function test_SetPolManager_RejectsZero() public {
        POLVault v = new POLVault(owner);
        vm.expectRevert(POLVault.ZeroAddress.selector);
        v.setPolManager(address(0));
    }

    function test_RecordRevertsBeforePolManagerSet() public {
        POLVault v = new POLVault(owner);
        vm.prank(polManager);
        vm.expectRevert(POLVault.PolManagerNotSet.selector);
        v.recordDeployment(1, winnerA, 1 ether, 1 ether, 1);
    }

    // ============================================================ recordDeployment auth

    function test_RecordDeployment_RejectsUnauthorizedCaller() public {
        vm.prank(attacker);
        vm.expectRevert(POLVault.NotPolManager.selector);
        polVault.recordDeployment(1, winnerA, 1 ether, 1 ether, 1);
        assertFalse(polVault.recorded(1));
    }

    function test_RecordDeployment_HappyPath() public {
        vm.prank(polManager);
        polVault.recordDeployment(1, winnerA, 5 ether, 1000 ether, 12_345);

        assertTrue(polVault.recorded(1));
        POLVault.Deployment memory d = polVault.deploymentOf(1);
        assertEq(d.winner, winnerA);
        assertEq(d.wethDeployed, 5 ether);
        assertEq(d.tokensDeployed, 1000 ether);
        assertEq(d.liquidity, 12_345);
        assertEq(d.deployedAt, uint64(block.timestamp));
    }

    function test_RecordDeployment_RejectsDuplicateSeason() public {
        vm.prank(polManager);
        polVault.recordDeployment(1, winnerA, 1 ether, 100 ether, 1);

        vm.prank(polManager);
        vm.expectRevert(POLVault.AlreadyRecorded.selector);
        polVault.recordDeployment(1, winnerA, 2 ether, 200 ether, 2);
    }

    function test_RecordDeployment_PerSeasonIndependent() public {
        vm.prank(polManager);
        polVault.recordDeployment(1, winnerA, 5 ether, 100 ether, 10);
        vm.prank(polManager);
        polVault.recordDeployment(2, winnerB, 3 ether, 50 ether, 20);

        assertTrue(polVault.recorded(1));
        assertTrue(polVault.recorded(2));
        assertEq(polVault.deploymentOf(1).winner, winnerA);
        assertEq(polVault.deploymentOf(2).winner, winnerB);
    }

    // ============================================================ aggregations + views

    function test_TotalsAcrossSeasons() public {
        vm.prank(polManager);
        polVault.recordDeployment(1, winnerA, 5 ether, 100 ether, 10);
        vm.prank(polManager);
        polVault.recordDeployment(2, winnerB, 3 ether, 50 ether, 20);
        vm.prank(polManager);
        polVault.recordDeployment(3, winnerA, 7 ether, 200 ether, 15);

        // Headline totals.
        assertEq(polVault.getTotalPOLValue(), 15 ether, "total weth");
        assertEq(polVault.totalLiquidity(), 45, "total liquidity");
        assertEq(polVault.deploymentCount(), 3, "count");

        // Per-token: winnerA won twice (5 + 7 weth, 10 + 15 liq).
        assertEq(polVault.getTokenPOLValue(winnerA), 12 ether);
        assertEq(polVault.tokenLiquidity(winnerA), 25);
        assertEq(polVault.getTokenPOLValue(winnerB), 3 ether);
        assertEq(polVault.tokenLiquidity(winnerB), 20);
    }

    function test_GetSeasonList_ReturnsInDeployOrder() public {
        vm.prank(polManager);
        polVault.recordDeployment(7, winnerA, 1 ether, 1 ether, 1);
        vm.prank(polManager);
        polVault.recordDeployment(3, winnerB, 1 ether, 1 ether, 1);
        vm.prank(polManager);
        polVault.recordDeployment(11, winnerA, 1 ether, 1 ether, 1);

        uint256[] memory list = polVault.getSeasonList();
        assertEq(list.length, 3);
        assertEq(list[0], 7);
        assertEq(list[1], 3);
        assertEq(list[2], 11);
    }

    function test_GetLPPositions_ReturnsAllRecords() public {
        vm.prank(polManager);
        polVault.recordDeployment(1, winnerA, 5 ether, 100 ether, 10);
        vm.prank(polManager);
        polVault.recordDeployment(2, winnerB, 3 ether, 50 ether, 20);

        POLVault.Deployment[] memory positions = polVault.getLPPositions();
        assertEq(positions.length, 2);
        assertEq(positions[0].winner, winnerA);
        assertEq(positions[0].wethDeployed, 5 ether);
        assertEq(positions[1].winner, winnerB);
        assertEq(positions[1].liquidity, 20);
    }

    function test_DeploymentCountStartsZero() public view {
        assertEq(polVault.deploymentCount(), 0);
        assertEq(polVault.getTotalPOLValue(), 0);
    }

    // ============================================================ recorded() flag distinguishes
    //                                                                zero-deployment from never-deployed

    function test_RecordedFlagDistinguishesZeroFromUnset() public {
        // Season 1: never recorded.
        assertFalse(polVault.recorded(1));
        // After zero-amount record (theoretical edge — POLManager guards against zero too,
        // but the flag is what disambiguates accounting downstream).
        vm.prank(polManager);
        polVault.recordDeployment(1, winnerA, 0, 0, 0);
        assertTrue(polVault.recorded(1));
        // Re-recording the same season is rejected even with zero values.
        vm.prank(polManager);
        vm.expectRevert(POLVault.AlreadyRecorded.selector);
        polVault.recordDeployment(1, winnerA, 1 ether, 100 ether, 5);
    }
}
