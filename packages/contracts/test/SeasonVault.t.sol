// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MiniMerkle} from "./utils/MiniMerkle.sol";

import {SeasonVault, IBonusFunding} from "../src/SeasonVault.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MintableERC20} from "./mocks/MintableERC20.sol";
import {MockLpLocker} from "./mocks/MockLpLocker.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";

contract SeasonVaultTest is Test {
    MockUSDC usdc;
    MockLauncherView launcher;
    BonusDistributor bonus;
    SeasonVault vault;

    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polRecipient = address(0xF000);

    address aliceUser = address(0xA1);
    address bobUser = address(0xB2);

    address winnerToken;
    MockLpLocker winnerLocker;

    address loserA;
    address loserB;
    MockLpLocker loserALocker;
    MockLpLocker loserBLocker;

    function setUp() public {
        usdc = new MockUSDC();
        launcher = new MockLauncherView();
        bonus = new BonusDistributor(address(launcher), address(usdc), oracle);
        vault = new SeasonVault(
            address(launcher),
            1,
            address(usdc),
            oracle,
            treasury,
            mechanics,
            polRecipient,
            IBonusFunding(address(bonus)),
            14 days
        );

        winnerToken = address(new MintableERC20("Winner", "WIN"));
        loserA = address(new MintableERC20("LoserA", "LA"));
        loserB = address(new MintableERC20("LoserB", "LB"));

        winnerLocker = new MockLpLocker(winnerToken, address(usdc), address(vault));
        loserALocker = new MockLpLocker(loserA, address(usdc), address(vault));
        loserBLocker = new MockLpLocker(loserB, address(usdc), address(vault));

        launcher.setLocker(1, winnerToken, address(winnerLocker));
        launcher.setLocker(1, loserA, address(loserALocker));
        launcher.setLocker(1, loserB, address(loserBLocker));

        // Each loser produces 1000 USDC on liquidation.
        loserALocker.setLiquidationProceeds(1000e6);
        loserBLocker.setLiquidationProceeds(1000e6);
        // Winner mints at 100 winner-tokens per 1 USDC (token has 18 decimals).
        winnerLocker.setMintRate(100e18);
    }

    // Share weights chosen so the share/winner-token math is exact:
    //   totalShares = 80, rolloverWinnerTokens = 70_000e18
    //   alice (50/80) → 43_750e18, bob (30/80) → 26_250e18
    uint256 internal constant ALICE_SHARE = 50;
    uint256 internal constant BOB_SHARE = 30;
    uint256 internal constant TOTAL_SHARES = 80;

    function _leaves() internal view returns (bytes32 leafA, bytes32 leafB) {
        leafA = keccak256(abi.encodePacked(aliceUser, ALICE_SHARE));
        leafB = keccak256(abi.encodePacked(bobUser, BOB_SHARE));
    }

    function _submit() internal returns (bytes32) {
        address[] memory losers = new address[](2);
        losers[0] = loserA;
        losers[1] = loserB;
        uint256[] memory minOuts = new uint256[](2);

        (bytes32 leafA, bytes32 leafB) = _leaves();
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);

        vm.prank(oracle);
        vault.submitSettlement(winnerToken, losers, minOuts, root, TOTAL_SHARES, block.timestamp + 7 days);
        return root;
    }

    function test_FullSettlementFlow() public {
        bytes32 root = _submit();
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Liquidating));

        // Liquidate both losers. Anyone can call.
        vault.liquidate(loserA, 0);
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Liquidating));
        vault.liquidate(loserB, 0);
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Aggregating));

        // Pot is 2000 USDC. Allocations should be:
        // rollover 35% = 700, bonus 15% = 300, POL 20% = 400, treasury 20% = 400, mechanics 10% = 200.
        uint256 potBefore = usdc.balanceOf(address(vault));
        assertEq(potBefore, 2000e6);

        vault.finalize(0, 0);

        // Treasury & mechanics paid in USDC.
        assertEq(usdc.balanceOf(treasury), 400e6);
        assertEq(usdc.balanceOf(mechanics), 200e6);

        // Bonus reserve in BonusDistributor.
        assertEq(usdc.balanceOf(address(bonus)), 300e6);
        BonusDistributor.SeasonBonus memory b = bonus.bonusOf(1);
        assertEq(b.reserve, 300e6);
        assertEq(b.winnerToken, winnerToken);
        assertEq(b.unlockTime, block.timestamp + 14 days);

        // POL bought winner tokens at rate 100 tokens/USDC: 400e6 USDC * 100e18 / 1e6 = 4e22 = 40_000e18
        assertEq(IERC20(winnerToken).balanceOf(polRecipient), 40_000e18);

        // Rollover bought winner tokens: 700e6 * 100e18 / 1e6 = 70_000e18, held by vault for claim.
        assertEq(vault.rolloverWinnerTokens(), 70_000e18);
        assertEq(IERC20(winnerToken).balanceOf(address(vault)), 70_000e18);

        // Phase advanced.
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Distributing));

        // Alice claims via Merkle proof. Share 50/80 of 70_000e18 winner tokens = 43_750e18.
        (bytes32 leafA, bytes32 leafB) = _leaves();
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(aliceUser);
        vault.claimRollover(ALICE_SHARE, proofA);
        assertEq(IERC20(winnerToken).balanceOf(aliceUser), 43_750e18);

        // Bob claims. Share 30/80 of 70_000e18 = 26_250e18.
        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(bobUser);
        vault.claimRollover(BOB_SHARE, proofB);
        assertEq(IERC20(winnerToken).balanceOf(bobUser), 26_250e18);

        // Double-claim reverts.
        vm.prank(aliceUser);
        vm.expectRevert(SeasonVault.AlreadyClaimed.selector);
        vault.claimRollover(ALICE_SHARE, proofA);

        root;
    }

    function test_OnlyOracleSubmit() public {
        address[] memory losers = new address[](0);
        uint256[] memory minOuts = new uint256[](0);
        vm.expectRevert(SeasonVault.NotOracle.selector);
        vault.submitSettlement(winnerToken, losers, minOuts, bytes32(0), TOTAL_SHARES, block.timestamp + 1);
    }

    function test_RejectDoubleSettle() public {
        _submit();
        address[] memory losers = new address[](0);
        uint256[] memory minOuts = new uint256[](0);
        vm.prank(oracle);
        vm.expectRevert(SeasonVault.WrongPhase.selector);
        vault.submitSettlement(winnerToken, losers, minOuts, bytes32(0), TOTAL_SHARES, block.timestamp + 1);
    }

    function test_RejectUnknownLoser() public {
        _submit();
        vm.expectRevert(SeasonVault.UnknownLoser.selector);
        vault.liquidate(address(0xBAD), 0);
    }

    function test_RejectDoubleLiquidate() public {
        _submit();
        vault.liquidate(loserA, 0);
        vm.expectRevert(SeasonVault.AlreadyLiquidated.selector);
        vault.liquidate(loserA, 0);
    }

    function test_MinOutFloorEnforced() public {
        // Floor 1500e6, locker proceeds 1000e6 → reverts at locker level via mock require.
        address[] memory losers = new address[](1);
        losers[0] = loserA;
        uint256[] memory minOuts = new uint256[](1);
        minOuts[0] = 1500e6;
        vm.prank(oracle);
        vault.submitSettlement(winnerToken, losers, minOuts, bytes32(0), 1, block.timestamp + 1 days);
        vm.expectRevert(bytes("minOut"));
        vault.liquidate(loserA, 0);
    }

    function test_ForceCloseAfterDeadline() public {
        _submit();
        vault.liquidate(loserA, 0);
        // Don't liquidate B; deadline passes.
        vm.warp(block.timestamp + 8 days);
        vm.prank(address(launcher));
        vault.forceClose();
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Aggregating));
        // Pot only includes A's 1000.
        vault.finalize(0, 0);
        assertEq(vault.totalPot(), 1000e6);
    }

    function test_ForceCloseRequiresLauncher() public {
        _submit();
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(SeasonVault.NotLauncher.selector);
        vault.forceClose();
    }

    function test_AllocationMathExact() public pure {
        uint256 sum = 3500 + 1500 + 2000 + 2000 + 1000;
        require(sum == 10_000, "bps");
    }
}
