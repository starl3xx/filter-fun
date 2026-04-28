// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {SeasonVault, IBonusFunding} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../../src/interfaces/IFilterLauncher.sol";

import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";
import {MockLpLocker} from "../mocks/MockLpLocker.sol";
import {MiniMerkle} from "../utils/MiniMerkle.sol";

/// @notice End-to-end happy path on mocks: protocol launches $FILTER, two users launch tokens,
///         oracle advances phases through the week, settlement runs, rollover claims execute,
///         and the hold-bonus claim closes out the loop. Mirrors the spec's weekly lifecycle.
contract WeeklyLifecycleTest is Test {
    FilterLauncher launcher;
    MockFilterFactory factory;
    BonusDistributor bonus;
    MockUSDC usdc;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polRecipient = address(0xF000);

    address creator1 = address(0xC1);
    address creator2 = address(0xC2);
    address holderA = address(0xA1);
    address holderB = address(0xB2);

    function setUp() public {
        usdc = new MockUSDC();
        bonus = new BonusDistributor(address(0), address(usdc), oracle);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, polRecipient, IBonusFunding(address(bonus)), address(usdc)
        );
        factory = new MockFilterFactory(address(launcher), address(usdc));
        launcher.setFactory(IFilterFactory(address(factory)));
    }

    function test_FullWeek() public {
        // Day 1: Open Season 1.
        vm.prank(oracle);
        uint256 sid = launcher.startSeason();

        // Day 1: Protocol launches $FILTER.
        (address filterToken, address filterLocker) =
            launcher.launchProtocolToken("filter.fun", "FILTER", "ipfs://filter");
        IFilterLauncher.TokenEntry memory entry = launcher.entryOf(sid, filterToken);
        assertEq(entry.isProtocolLaunched, true);

        // Day 1-2: Users launch tokens.
        vm.prank(creator1);
        (address tokenA,) = launcher.launch("Pepe", "PEPE", "");
        vm.prank(creator2);
        (address tokenB,) = launcher.launch("Wojak", "WOJAK", "");

        // Day 3: Filter phase.
        vm.warp(block.timestamp + 2 days);
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);

        // Pretend ranking: $FILTER + tokenA advance, tokenB does not.
        address[] memory finalists = new address[](2);
        finalists[0] = filterToken;
        finalists[1] = tokenA;
        vm.prank(oracle);
        launcher.setFinalists(sid, finalists);

        // Day 4-6: Finals.
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Finals);

        // Day 7: Settlement phase open.
        vm.warp(block.timestamp + 4 days);
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Settlement);

        // Pretend each losing token unwinds to a known USDC amount (mock).
        // Winner is $FILTER. Losers: tokenA, tokenB.
        SeasonVault vault = SeasonVault(launcher.vaultOf(sid));
        MockLpLocker(launcher.lockerOf(sid, tokenA)).setLiquidationProceeds(1500e6);
        MockLpLocker(launcher.lockerOf(sid, tokenB)).setLiquidationProceeds(2500e6);
        // $FILTER (winner) mints at 100 winner-tokens / 1 USDC.
        MockLpLocker(filterLocker).setMintRate(100e18);

        // Settlement Merkle: rollover share weights — holderA=60, holderB=40, total=100.
        // After finalize, vault holds 140_000e18 winner tokens; payouts will be
        //   holderA: 60/100 * 140_000e18 = 84_000e18
        //   holderB: 40/100 * 140_000e18 = 56_000e18
        bytes32 leafA = keccak256(abi.encodePacked(holderA, uint256(60)));
        bytes32 leafB = keccak256(abi.encodePacked(holderB, uint256(40)));
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);

        address[] memory losers = new address[](2);
        losers[0] = tokenA;
        losers[1] = tokenB;
        uint256[] memory minOuts = new uint256[](2);

        vm.prank(oracle);
        vault.submitSettlement(filterToken, losers, minOuts, root, 100, block.timestamp + 1 days);

        // Keeper liquidates each loser.
        vault.liquidate(tokenA, 0);
        vault.liquidate(tokenB, 0);

        // Pot = 4_000 USDC. Allocations:
        // rollover 35% = 1400, bonus 15% = 600, POL 20% = 800, treasury 20% = 800, mechanics 10% = 400.
        assertEq(usdc.balanceOf(address(vault)), 4000e6);
        vault.finalize(0, 0);

        assertEq(usdc.balanceOf(treasury), 800e6);
        assertEq(usdc.balanceOf(mechanics), 400e6);
        assertEq(usdc.balanceOf(address(bonus)), 600e6);

        // Rollover bought 1400e6 * 100e18 / 1e6 = 1.4e23 winner tokens, held by vault.
        assertEq(IERC20(filterToken).balanceOf(address(vault)), 140_000e18);
        // POL bought 800e6 * 100e18 / 1e6 = 80_000e18 winner tokens, sent to polRecipient.
        assertEq(IERC20(filterToken).balanceOf(polRecipient), 80_000e18);

        // Holders claim rollover.
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(holderA);
        vault.claimRollover(60, proofA);
        assertEq(IERC20(filterToken).balanceOf(holderA), 84_000e18);

        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(holderB);
        vault.claimRollover(40, proofB);
        assertEq(IERC20(filterToken).balanceOf(holderB), 56_000e18);

        // 14 days pass; oracle posts bonus eligibility root.
        vm.warp(block.timestamp + 14 days);
        // Pretend only holderA was eligible for the bonus (held ≥80% across snapshots).
        bytes32 bonusLeafA = keccak256(abi.encodePacked(holderA, uint256(600e6))); // gets full reserve
        bytes32 bonusLeafB = keccak256(abi.encodePacked(holderB, uint256(0)));
        bytes32 bonusRoot = MiniMerkle.rootOfTwo(bonusLeafA, bonusLeafB);

        vm.prank(oracle);
        bonus.postRoot(sid, bonusRoot);

        bytes32[2] memory bonusLeaves = [bonusLeafA, bonusLeafB];
        bytes32[] memory bonusProofA = MiniMerkle.proofForTwo(bonusLeaves, 0);
        vm.prank(holderA);
        bonus.claim(sid, 600e6, bonusProofA);
        assertEq(usdc.balanceOf(holderA), 600e6);
    }
}
