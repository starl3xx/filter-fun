// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MiniMerkle} from "./utils/MiniMerkle.sol";

import {SeasonVault, IBonusFunding} from "../src/SeasonVault.sol";
import {SeasonPOLReserve} from "../src/SeasonPOLReserve.sol";
import {POLVault} from "../src/POLVault.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MintableERC20} from "./mocks/MintableERC20.sol";
import {MockLpLocker} from "./mocks/MockLpLocker.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";

/// @notice Covers the user-aligned settlement model: BPS split per filter event, POL
///         accumulation across multiple events, one-shot final deployment, and rollover claims.
///         The mock locker mints winner tokens at a fixed rate so the math is exact.
contract SeasonVaultTest is Test {
    MockWETH weth;
    MockLauncherView launcher;
    BonusDistributor bonus;
    POLVault polVault;
    SeasonVault vault;

    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polVaultOwner = address(0xF111);

    address aliceUser = address(0xA1);
    address bobUser = address(0xB2);

    address winnerToken;
    MockLpLocker winnerLocker;

    address loserA;
    address loserB;
    address loserC;
    MockLpLocker loserALocker;
    MockLpLocker loserBLocker;
    MockLpLocker loserCLocker;

    function setUp() public {
        weth = new MockWETH();
        launcher = new MockLauncherView();
        bonus = new BonusDistributor(address(launcher), address(weth), oracle);
        polVault = new POLVault(polVaultOwner);
        vault = new SeasonVault(
            address(launcher),
            1,
            address(weth),
            oracle,
            treasury,
            mechanics,
            address(polVault),
            IBonusFunding(address(bonus)),
            14 days
        );

        winnerToken = address(new MintableERC20("Winner", "WIN"));
        loserA = address(new MintableERC20("LoserA", "LA"));
        loserB = address(new MintableERC20("LoserB", "LB"));
        loserC = address(new MintableERC20("LoserC", "LC"));

        winnerLocker = new MockLpLocker(winnerToken, address(weth), address(vault));
        loserALocker = new MockLpLocker(loserA, address(weth), address(vault));
        loserBLocker = new MockLpLocker(loserB, address(weth), address(vault));
        loserCLocker = new MockLpLocker(loserC, address(weth), address(vault));

        launcher.setLocker(1, winnerToken, address(winnerLocker));
        launcher.setLocker(1, loserA, address(loserALocker));
        launcher.setLocker(1, loserB, address(loserBLocker));
        launcher.setLocker(1, loserC, address(loserCLocker));

        // Each loser produces 1 WETH on liquidation; the cohort has three losers.
        loserALocker.setLiquidationProceeds(1 ether);
        loserBLocker.setLiquidationProceeds(1 ether);
        loserCLocker.setLiquidationProceeds(1 ether);
        // Winner mints 100_000 winner-tokens per 1 WETH (both 18-decimal).
        winnerLocker.setMintRate(100_000e18);
    }

    // Share weights chosen so the share/winner-token math is exact:
    //   totalShares = 80, alice 50, bob 30
    uint256 internal constant ALICE_SHARE = 50;
    uint256 internal constant BOB_SHARE = 30;
    uint256 internal constant TOTAL_SHARES = 80;

    function _leaves() internal view returns (bytes32 leafA, bytes32 leafB) {
        leafA = keccak256(abi.encodePacked(aliceUser, ALICE_SHARE));
        leafB = keccak256(abi.encodePacked(bobUser, BOB_SHARE));
    }

    function _filter(address[] memory tokens) internal {
        uint256[] memory minOuts = new uint256[](tokens.length);
        vm.prank(oracle);
        vault.processFilterEvent(tokens, minOuts);
    }

    function _filterOne(address t) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = t;
        _filter(tokens);
    }

    function _submit(bytes32 root) internal {
        vm.prank(oracle);
        vault.submitWinner(winnerToken, root, TOTAL_SHARES, 0, 0);
    }

    // ============================================================ Constants

    function test_BpsSumToTenThousand() public pure {
        uint256 sum = 4500 + 2500 + 1000 + 1000 + 1000;
        require(sum == 10_000, "bps");
    }

    // ============================================================ Per-event split

    /// @notice One filter event with one loser → 1 WETH split exactly per BPS.
    function test_FilterEvent_SplitMatchesBps() public {
        _filterOne(loserA);

        // 1 WETH liquidated → 4500/2500/1000/1000/1000 BPS split.
        assertEq(vault.rolloverReserve(), 0.45 ether, "rollover acc");
        assertEq(vault.bonusReserve(), 0.25 ether, "bonus acc");
        assertEq(weth.balanceOf(mechanics), 0.10 ether, "mechanics paid");
        assertEq(weth.balanceOf(treasury), 0.10 ether, "treasury paid");
        assertEq(vault.polReserveBalance(), 0.10 ether, "pol reserve");
        assertEq(vault.totalLiquidationProceeds(), 1 ether, "total proceeds");
        assertEq(vault.filterEventCount(), 1, "event count");
    }

    /// @notice Three filter events accumulate rollover/bonus/POL while paying mechanics +
    ///         treasury immediately on each event.
    function test_MultipleFilterEvents_Accumulate() public {
        _filterOne(loserA);
        _filterOne(loserB);
        _filterOne(loserC);

        assertEq(vault.rolloverReserve(), 1.35 ether, "rollover acc"); // 0.45 * 3
        assertEq(vault.bonusReserve(), 0.75 ether, "bonus acc"); // 0.25 * 3
        assertEq(weth.balanceOf(mechanics), 0.30 ether, "mechanics");
        assertEq(weth.balanceOf(treasury), 0.30 ether, "treasury");
        assertEq(vault.polReserveBalance(), 0.30 ether, "pol reserve");
        assertEq(vault.filterEventCount(), 3, "event count");
        assertEq(vault.totalPolAccumulated(), 0.30 ether, "pol cumulative");
    }

    /// @notice POL is held as WETH; no winner-token purchase happens before submitWinner.
    function test_PolNotDeployedDuringWeek() public {
        _filterOne(loserA);
        _filterOne(loserB);

        // No winner tokens have been bought yet.
        assertEq(IERC20(winnerToken).balanceOf(address(vault)), 0);
        assertEq(IERC20(winnerToken).balanceOf(address(polVault)), 0);
        // POL reserve holds WETH only.
        SeasonPOLReserve r = vault.polReserve();
        assertEq(weth.balanceOf(address(r)), 0.20 ether);
        assertEq(r.deployed(), false);
    }

    // ============================================================ Final settlement

    function test_FullLifecycle_AccumulateThenDeploy() public {
        // Three filter events of 1 WETH each → 3 WETH total proceeds.
        _filterOne(loserA);
        _filterOne(loserB);
        _filterOne(loserC);

        (bytes32 leafA, bytes32 leafB) = _leaves();
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);
        _submit(root);

        // Rollover: 1.35 WETH × 100_000 tokens/WETH = 135_000e18 tokens held by vault.
        assertEq(vault.rolloverWinnerTokens(), 135_000e18, "rollover tokens");
        assertEq(IERC20(winnerToken).balanceOf(address(vault)), 135_000e18);
        assertEq(vault.rolloverReserve(), 0, "rollover reserve drained");

        // Bonus: 0.75 WETH funded into BonusDistributor.
        BonusDistributor.SeasonBonus memory b = bonus.bonusOf(1);
        assertEq(b.reserve, 0.75 ether, "bonus reserve");
        assertEq(b.winnerToken, winnerToken);
        assertEq(b.unlockTime, block.timestamp + 14 days);
        assertEq(weth.balanceOf(address(bonus)), 0.75 ether);
        assertEq(vault.bonusReserve(), 0, "bonus reserve drained");

        // POL: 0.30 WETH bought 30_000e18 winner tokens, deposited into POLVault.
        assertEq(vault.polDeployedWeth(), 0.30 ether);
        assertEq(vault.polDeployedTokens(), 30_000e18);
        assertEq(IERC20(winnerToken).balanceOf(address(polVault)), 30_000e18);
        assertEq(polVault.seasonDeposit(1), 30_000e18);
        assertEq(polVault.seasonWinner(1), winnerToken);
        assertEq(vault.polReserveBalance(), 0, "pol reserve drained");
        assertEq(vault.polReserve().deployed(), true);

        // Mechanics + treasury were paid per-event, not at finalize.
        assertEq(weth.balanceOf(mechanics), 0.30 ether);
        assertEq(weth.balanceOf(treasury), 0.30 ether);

        // Phase advanced.
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Distributing));
    }

    function test_RolloverClaim_Exact() public {
        _filterOne(loserA);
        _filterOne(loserB);
        _filterOne(loserC);

        (bytes32 leafA, bytes32 leafB) = _leaves();
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);
        _submit(root);

        // Alice claims via Merkle proof. Share 50/80 of 135_000e18 = 84_375e18.
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(aliceUser);
        vault.claimRollover(ALICE_SHARE, proofA);
        assertEq(IERC20(winnerToken).balanceOf(aliceUser), 84_375e18);

        // Bob claims. Share 30/80 of 135_000e18 = 50_625e18.
        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(bobUser);
        vault.claimRollover(BOB_SHARE, proofB);
        assertEq(IERC20(winnerToken).balanceOf(bobUser), 50_625e18);

        // Double-claim reverts.
        vm.prank(aliceUser);
        vm.expectRevert(SeasonVault.AlreadyClaimed.selector);
        vault.claimRollover(ALICE_SHARE, proofA);
    }

    // ============================================================ Trading-fee separation

    /// @notice WETH already in the vault (e.g. from FilterLpLocker fee streams) is NOT subject
    ///         to the losers-pot BPS — only the delta from the liquidation step is split. The
    ///         residue is swept to treasury at submitWinner.
    function test_TradingFeeStreamSeparate() public {
        // Simulate the FilterLpLocker forwarding 1 WETH of trading fees into the vault.
        weth.mint(address(vault), 1 ether);

        _filterOne(loserA); // adds 1 WETH from liquidation

        // Only the 1 WETH from liquidation got the BPS split.
        assertEq(vault.rolloverReserve(), 0.45 ether);
        assertEq(vault.bonusReserve(), 0.25 ether);
        assertEq(weth.balanceOf(mechanics), 0.10 ether);
        assertEq(weth.balanceOf(treasury), 0.10 ether);
        assertEq(vault.polReserveBalance(), 0.10 ether);

        // The pre-existing 1 WETH (trading fees) is still in the vault, untouched.
        assertEq(weth.balanceOf(address(vault)), 1 ether + 0.45 ether + 0.25 ether);

        // submitWinner sweeps trading-fee residue to treasury.
        _submit(bytes32(0));
        assertEq(weth.balanceOf(treasury), 0.10 ether + 1 ether, "trading-fee residue swept to treasury");
        // Vault has only the rollover-bought winner tokens left.
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    // ============================================================ Reserves reset post-finalize

    function test_ReservesResetAfterSettlement() public {
        _filterOne(loserA);
        _submit(bytes32(0));

        assertEq(vault.rolloverReserve(), 0);
        assertEq(vault.bonusReserve(), 0);
        assertEq(vault.polReserveBalance(), 0);
        assertEq(vault.polReserve().deployed(), true);
    }

    // ============================================================ Auth + phase

    function test_OnlyOracle_FilterEvent() public {
        address[] memory tokens = new address[](1);
        tokens[0] = loserA;
        uint256[] memory minOuts = new uint256[](1);
        vm.expectRevert(SeasonVault.NotOracle.selector);
        vault.processFilterEvent(tokens, minOuts);
    }

    function test_OnlyOracle_SubmitWinner() public {
        vm.expectRevert(SeasonVault.NotOracle.selector);
        vault.submitWinner(winnerToken, bytes32(0), TOTAL_SHARES, 0, 0);
    }

    function test_RejectDoubleSubmitWinner() public {
        _filterOne(loserA);
        _submit(bytes32(0));

        vm.prank(oracle);
        vm.expectRevert(SeasonVault.WrongPhase.selector);
        vault.submitWinner(winnerToken, bytes32(0), TOTAL_SHARES, 0, 0);
    }

    function test_RejectDoubleLiquidate() public {
        _filterOne(loserA);

        vm.expectRevert(SeasonVault.AlreadyLiquidated.selector);
        _filterOne(loserA);
    }

    function test_RejectWinnerWasFiltered() public {
        // Filter the winner-to-be in an earlier event.
        winnerLocker.setLiquidationProceeds(1 ether);
        _filterOne(winnerToken);

        vm.prank(oracle);
        vm.expectRevert(SeasonVault.WinnerWasFiltered.selector);
        vault.submitWinner(winnerToken, bytes32(0), TOTAL_SHARES, 0, 0);
    }

    function test_RejectZeroShares() public {
        _filterOne(loserA);
        vm.prank(oracle);
        vm.expectRevert(SeasonVault.ZeroShares.selector);
        vault.submitWinner(winnerToken, bytes32(0), 0, 0, 0);
    }

    function test_RejectEmptyEvent() public {
        address[] memory tokens = new address[](0);
        uint256[] memory minOuts = new uint256[](0);
        vm.prank(oracle);
        vm.expectRevert(SeasonVault.EmptyEvent.selector);
        vault.processFilterEvent(tokens, minOuts);
    }

    function test_RejectMinOutFloor() public {
        address[] memory tokens = new address[](1);
        tokens[0] = loserA;
        uint256[] memory minOuts = new uint256[](1);
        minOuts[0] = 1.5 ether; // floor above the 1 WETH proceeds → locker reverts
        vm.prank(oracle);
        vm.expectRevert(bytes("minOut"));
        vault.processFilterEvent(tokens, minOuts);
    }

    // ============================================================ POL reserve guards

    function test_PolReserve_OnlyVaultCanWithdraw() public {
        SeasonPOLReserve r = vault.polReserve();
        vm.expectRevert(SeasonPOLReserve.NotVault.selector);
        r.withdrawAll();
    }

    function test_PolReserve_OnlyVaultCanNotify() public {
        SeasonPOLReserve r = vault.polReserve();
        vm.expectRevert(SeasonPOLReserve.NotVault.selector);
        r.notifyDeposit(1 ether);
    }

    /// @notice POLVault rejects double-deposit per season — the SeasonVault.submitWinner path
    ///         is one-shot but make sure the invariant holds at the vault edge too.
    function test_PolVault_RejectDoubleDeposit() public {
        _filterOne(loserA);
        _submit(bytes32(0));

        // Try to deposit again from a fresh sender — should revert.
        MintableERC20 fakeWinner = new MintableERC20("Fake", "FAKE");
        fakeWinner.mint(address(this), 1 ether);
        IERC20(address(fakeWinner)).approve(address(polVault), 1 ether);
        vm.expectRevert(POLVault.AlreadyDeposited.selector);
        polVault.deposit(1, address(fakeWinner), 1 ether);
    }
}
