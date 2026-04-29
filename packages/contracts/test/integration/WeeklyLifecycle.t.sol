// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {SeasonVault, IBonusFunding} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {POLVault} from "../../src/POLVault.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../../src/interfaces/IFilterLauncher.sol";

import {MockWETH} from "../mocks/MockWETH.sol";
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
    POLVault polVault;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polVaultOwner = address(0xF111);

    address creator1 = address(0xC1);
    address creator2 = address(0xC2);
    address holderA = address(0xA1);
    address holderB = address(0xB2);

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        polVault = new POLVault(polVaultOwner);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, address(polVault), IBonusFunding(address(bonus)), address(weth)
        );
        factory = new MockFilterFactory(address(launcher), address(weth));
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

        // Set up the cohort. Both losers will be filtered — but in DIFFERENT events to
        // exercise the multi-filter accumulation path.
        SeasonVault vault = SeasonVault(launcher.vaultOf(sid));
        MockLpLocker(launcher.lockerOf(sid, tokenA)).setLiquidationProceeds(1.5 ether);
        MockLpLocker(launcher.lockerOf(sid, tokenB)).setLiquidationProceeds(2.5 ether);
        MockLpLocker(filterLocker).setMintRate(100_000e18);

        // Filter event 1 (mid-week): tokenB gets cut. Proceeds 2.5 WETH split per BPS.
        //   rollover 45% = 1.125,  bonus 25% = 0.625,  mechanics 10% = 0.25,
        //   POL 10% = 0.25,  treasury 10% = 0.25.
        address[] memory losers1 = new address[](1);
        losers1[0] = tokenB;
        uint256[] memory minOuts1 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(losers1, minOuts1);
        assertEq(vault.rolloverReserve(), 1.125 ether);
        assertEq(vault.bonusReserve(), 0.625 ether);
        assertEq(weth.balanceOf(mechanics), 0.25 ether, "mechanics paid mid-week");
        assertEq(weth.balanceOf(treasury), 0.25 ether, "treasury paid mid-week");
        assertEq(vault.polReserveBalance(), 0.25 ether, "POL accumulated");
        // POL is held as WETH — no winner-token purchases yet.
        assertEq(IERC20(filterToken).balanceOf(address(polVault)), 0, "POL not deployed mid-week");

        // Filter event 2 (final cut): tokenA. Proceeds 1.5 WETH split per BPS.
        //   rollover 45% = 0.675 (cumulative 1.8),  bonus 25% = 0.375 (cum 1.0),
        //   mechanics 10% = 0.15,  POL 10% = 0.15 (cum 0.4),  treasury 10% = 0.15.
        address[] memory losers2 = new address[](1);
        losers2[0] = tokenA;
        uint256[] memory minOuts2 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(losers2, minOuts2);
        assertEq(vault.rolloverReserve(), 1.8 ether);
        assertEq(vault.bonusReserve(), 1.0 ether);
        assertEq(weth.balanceOf(mechanics), 0.4 ether);
        assertEq(weth.balanceOf(treasury), 0.4 ether);
        assertEq(vault.polReserveBalance(), 0.4 ether);

        // Final settlement: $FILTER wins. Rollover Merkle weights — holderA=60, holderB=40.
        // After settlement, vault holds 1.8 WETH × 100_000 = 180_000e18 winner tokens for claim;
        // payouts: holderA 60/100 × 180_000e18 = 108_000e18, holderB = 72_000e18.
        bytes32 leafA = keccak256(abi.encodePacked(holderA, uint256(60)));
        bytes32 leafB = keccak256(abi.encodePacked(holderB, uint256(40)));
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);

        vm.prank(oracle);
        vault.submitWinner(filterToken, root, 100, 0, 0);

        // Bonus reserve forwarded to BonusDistributor.
        assertEq(weth.balanceOf(address(bonus)), 1.0 ether);

        // Rollover bought 180_000e18 winner tokens, held by vault.
        assertEq(IERC20(filterToken).balanceOf(address(vault)), 180_000e18);

        // POL deployed: 0.4 WETH × 100_000 = 40_000e18 winner tokens, parked in POLVault.
        assertEq(IERC20(filterToken).balanceOf(address(polVault)), 40_000e18);
        assertEq(polVault.seasonDeposit(sid), 40_000e18);
        assertEq(polVault.seasonWinner(sid), filterToken);

        // Holders claim rollover.
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(holderA);
        vault.claimRollover(60, proofA);
        assertEq(IERC20(filterToken).balanceOf(holderA), 108_000e18);

        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(holderB);
        vault.claimRollover(40, proofB);
        assertEq(IERC20(filterToken).balanceOf(holderB), 72_000e18);

        // 14 days pass; oracle posts bonus eligibility root. Bonus per leaf is computed
        // off-chain from rolloverAmount × (eligibility ? 1 : 0); only holderA qualified.
        vm.warp(block.timestamp + 14 days);
        bytes32 bonusLeafA = keccak256(abi.encodePacked(holderA, uint256(1.0 ether)));
        bytes32 bonusLeafB = keccak256(abi.encodePacked(holderB, uint256(0)));
        bytes32 bonusRoot = MiniMerkle.rootOfTwo(bonusLeafA, bonusLeafB);

        vm.prank(oracle);
        bonus.postRoot(sid, bonusRoot);

        bytes32[2] memory bonusLeaves = [bonusLeafA, bonusLeafB];
        bytes32[] memory bonusProofA = MiniMerkle.proofForTwo(bonusLeaves, 0);
        vm.prank(holderA);
        bonus.claim(sid, 1.0 ether, bonusProofA);
        assertEq(weth.balanceOf(holderA), 1.0 ether);
    }
}
