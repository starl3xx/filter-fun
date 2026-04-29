// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {SeasonVault, IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {POLVault} from "../../src/POLVault.sol";
import {POLManager, IPOLVaultRecord} from "../../src/POLManager.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../../src/interfaces/IFilterLauncher.sol";

import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";
import {MockLpLocker} from "../mocks/MockLpLocker.sol";
import {MockPOLManager} from "../mocks/MockPOLManager.sol";
import {MiniMerkle} from "../utils/MiniMerkle.sol";

/// @notice End-to-end happy path on mocks: protocol launches $FILTER, two users launch tokens,
///         oracle advances phases through the week, settlement runs, rollover claims execute,
///         and the hold-bonus claim closes out the loop. Mirrors the spec's weekly lifecycle.
contract WeeklyLifecycleTest is Test {
    FilterLauncher launcher;
    MockFilterFactory factory;
    BonusDistributor bonus;
    POLVault polVault;
    MockPOLManager polManager;
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
        polVault = new POLVault(address(this));
        polManager = new MockPOLManager(weth);
        polManager.setMintRate(100_000e18); // matches MockLpLocker default; see below
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        launcher.setPolManager(IPOLManager(address(polManager)));
        polVault.transferOwnership(polVaultOwner);
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

        // Filter event 1 (mid-week): tokenB gets cut. Proceeds 2.5 WETH:
        //   bounty 2.5%   = 0.0625
        //   remainder     = 2.4375; split 45/25/10/10/10 → 1.096875 / 0.609375 / 0.24375 × 3.
        address[] memory losers1 = new address[](1);
        losers1[0] = tokenB;
        uint256[] memory minOuts1 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(losers1, minOuts1);
        assertEq(vault.bountyReserve(), 0.0625 ether, "bounty mid-week");
        assertEq(vault.rolloverReserve(), 1.096_875 ether);
        assertEq(vault.bonusReserve(), 0.609_375 ether);
        assertEq(weth.balanceOf(mechanics), 0.243_75 ether, "mechanics paid mid-week");
        assertEq(weth.balanceOf(treasury), 0.243_75 ether, "treasury paid mid-week");
        assertEq(vault.polReserveBalance(), 0.243_75 ether, "POL accumulated");
        // POL is held as WETH — no winner-token purchases yet.
        assertEq(IERC20(filterToken).balanceOf(address(polVault)), 0, "POL not deployed mid-week");

        // Filter event 2 (final cut): tokenA. Proceeds 1.5 WETH:
        //   bounty 2.5%   = 0.0375 (cum 0.1)
        //   remainder     = 1.4625; rollover 0.658125 (cum 1.755), bonus 0.365625 (cum 0.975),
        //   mechanics/POL/treasury 0.14625 each (cum 0.39 each).
        address[] memory losers2 = new address[](1);
        losers2[0] = tokenA;
        uint256[] memory minOuts2 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(losers2, minOuts2);
        assertEq(vault.bountyReserve(), 0.1 ether);
        assertEq(vault.rolloverReserve(), 1.755 ether);
        assertEq(vault.bonusReserve(), 0.975 ether);
        assertEq(weth.balanceOf(mechanics), 0.39 ether);
        assertEq(weth.balanceOf(treasury), 0.39 ether);
        assertEq(vault.polReserveBalance(), 0.39 ether);

        // Final settlement: $FILTER wins. Rollover Merkle weights — holderA=60, holderB=40.
        // Rollover-bought tokens = 1.755 × 100_000 = 175_500e18; payouts:
        //   holderA 60/100 × 175_500e18 = 105_300e18
        //   holderB 40/100 × 175_500e18 = 70_200e18
        bytes32 leafA = keccak256(abi.encodePacked(holderA, uint256(60)));
        bytes32 leafB = keccak256(abi.encodePacked(holderB, uint256(40)));
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);

        vm.prank(oracle);
        vault.submitWinner(filterToken, root, 100, 0, 0);

        // Bonus reserve forwarded to BonusDistributor.
        assertEq(weth.balanceOf(address(bonus)), 0.975 ether);

        // Rollover bought 175_500e18 winner tokens, held by vault.
        assertEq(IERC20(filterToken).balanceOf(address(vault)), 175_500e18);

        // POL deployed: 0.39 WETH committed via the (mock) POLManager. The mock reports
        // tokensDeployed at the configured 100_000-tokens-per-WETH mintRate even though no
        // real LP is added — the SeasonVault → POLManager seam is what we're exercising here.
        assertEq(polManager.callCount(), 1, "polManager invoked at submitWinner");
        assertEq(polManager.lastSender(), address(vault));
        assertEq(polManager.lastSeasonId(), sid);
        assertEq(polManager.lastWinner(), filterToken);
        assertEq(polManager.lastWethAmount(), 0.39 ether);
        assertEq(polManager.lastTokens(), 39_000e18);
        assertEq(vault.polDeployedWeth(), 0.39 ether);
        assertEq(vault.polDeployedTokens(), 39_000e18);

        // Champion bounty (0.1 WETH) paid to filterToken's creator. The launcher records
        // creator = msg.sender at launch time — for `launchProtocolToken` that's `address(this)`.
        assertEq(weth.balanceOf(address(this)), 0.1 ether, "bounty paid to filter creator");

        // Holders claim rollover.
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(holderA);
        vault.claimRollover(60, proofA);
        assertEq(IERC20(filterToken).balanceOf(holderA), 105_300e18);

        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(holderB);
        vault.claimRollover(40, proofB);
        assertEq(IERC20(filterToken).balanceOf(holderB), 70_200e18);

        // 14 days pass; oracle posts bonus eligibility root. Bonus per leaf is computed
        // off-chain from rolloverAmount × (eligibility ? 1 : 0); only holderA qualified.
        // Distributor was funded with bonusReserve = 0.975 WETH; allocate it all to holderA.
        vm.warp(block.timestamp + 14 days);
        bytes32 bonusLeafA = keccak256(abi.encodePacked(holderA, uint256(0.975 ether)));
        bytes32 bonusLeafB = keccak256(abi.encodePacked(holderB, uint256(0)));
        bytes32 bonusRoot = MiniMerkle.rootOfTwo(bonusLeafA, bonusLeafB);

        vm.prank(oracle);
        bonus.postRoot(sid, bonusRoot);

        bytes32[2] memory bonusLeaves = [bonusLeafA, bonusLeafB];
        bytes32[] memory bonusProofA = MiniMerkle.proofForTwo(bonusLeaves, 0);
        vm.prank(holderA);
        bonus.claim(sid, 0.975 ether, bonusProofA);
        assertEq(weth.balanceOf(holderA), 0.975 ether);
    }
}
