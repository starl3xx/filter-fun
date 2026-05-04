// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MiniMerkle} from "./utils/MiniMerkle.sol";

import {
    SeasonVault,
    IBonusFunding,
    IPOLManager,
    ICreatorRegistry,
    ICreatorFeeDistributor,
    ITournamentRegistry
} from "../src/SeasonVault.sol";
import {SeasonPOLReserve} from "../src/SeasonPOLReserve.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MintableERC20} from "./mocks/MintableERC20.sol";
import {MockLpLocker} from "./mocks/MockLpLocker.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";
import {MockCreatorRegistry} from "./mocks/MockCreatorRegistry.sol";
import {MockCreatorFeeDistributor} from "./mocks/MockCreatorFeeDistributor.sol";
import {MockPOLManager} from "./mocks/MockPOLManager.sol";
import {MockTournamentRegistry} from "./mocks/MockTournamentRegistry.sol";

/// @notice Covers the user-aligned settlement model: BPS split per filter event, POL
///         accumulation across multiple events, one-shot final deployment, and rollover claims.
///         The mock locker mints winner tokens at a fixed rate so the math is exact.
contract SeasonVaultTest is Test {
    MockWETH weth;
    MockLauncherView launcher;
    BonusDistributor bonus;
    MockPOLManager polManager;
    MockCreatorRegistry creatorRegistry;
    MockCreatorFeeDistributor creatorFeeDistributor;
    MockTournamentRegistry tournamentRegistry;
    SeasonVault vault;

    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address winnerCreator = address(0xC0FFEE);

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
        // Wire the launcher's oracle BEFORE constructing the vault: SeasonVault now reads
        // `launcher.oracle()` live (audit H-2) so an unset launcher oracle would make every
        // privileged entry revert with NotOracle.
        launcher.setOracle(oracle);
        bonus = new BonusDistributor(address(launcher), address(weth), oracle);
        polManager = new MockPOLManager(weth);
        // 100_000 winner-tokens per 1 WETH, matching the winner-locker mintRate so the test
        // can compare polDeployedTokens against rolloverWinnerTokens analytically.
        polManager.setMintRate(100_000e18);
        polManager.setLiquidityReturn(uint128(123)); // arbitrary; only equality checks use it
        creatorRegistry = new MockCreatorRegistry();
        creatorFeeDistributor = new MockCreatorFeeDistributor();
        tournamentRegistry = new MockTournamentRegistry();
        vault = new SeasonVault(
            address(launcher),
            1,
            address(weth),
            treasury,
            mechanics,
            IPOLManager(address(polManager)),
            IBonusFunding(address(bonus)),
            14 days,
            ICreatorRegistry(address(creatorRegistry)),
            ICreatorFeeDistributor(address(creatorFeeDistributor)),
            ITournamentRegistry(address(tournamentRegistry))
        );
        launcher.setVault(1, address(vault));

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
        // Bounty (250) is off-the-top; the remaining four-way split sums to 10_000.
        uint256 sum = 4500 + 2500 + 1000 + 1000 + 1000;
        require(sum == 10_000, "bps");
    }

    // ============================================================ Per-event split

    /// @notice One filter event with one loser → 1 WETH split as 2.5% bounty + 97.5% × 45/25/10/10/10.
    ///         All numbers exact thanks to round 1 ether and the integer math.
    function test_FilterEvent_SplitMatchesBps() public {
        _filterOne(loserA);

        // 1 WETH liquidated:
        //   bounty   = 1 × 250/10000  = 0.025  ether
        //   rollover = 0.975 × 4500/10000 = 0.43875 ether
        //   bonus    = 0.975 × 2500/10000 = 0.24375 ether
        //   each of mechanics/POL/treasury = 0.975 × 1000/10000 = 0.0975 ether
        assertEq(vault.bountyReserve(), 0.025 ether, "bounty acc");
        assertEq(vault.rolloverReserve(), 0.438_75 ether, "rollover acc");
        assertEq(vault.bonusReserve(), 0.243_75 ether, "bonus acc");
        assertEq(weth.balanceOf(mechanics), 0.0975 ether, "mechanics paid");
        assertEq(weth.balanceOf(treasury), 0.0975 ether, "treasury paid");
        assertEq(vault.polReserveBalance(), 0.0975 ether, "pol reserve");
        assertEq(vault.totalLiquidationProceeds(), 1 ether, "total proceeds");
        assertEq(vault.filterEventCount(), 1, "event count");
    }

    /// @notice Three filter events accumulate rollover/bonus/POL/bounty while paying mechanics +
    ///         treasury immediately on each event.
    function test_MultipleFilterEvents_Accumulate() public {
        _filterOne(loserA);
        _filterOne(loserB);
        _filterOne(loserC);

        assertEq(vault.bountyReserve(), 0.075 ether, "bounty acc"); // 0.025 * 3
        assertEq(vault.rolloverReserve(), 1.316_25 ether, "rollover acc"); // 0.43875 * 3
        assertEq(vault.bonusReserve(), 0.731_25 ether, "bonus acc"); // 0.24375 * 3
        assertEq(weth.balanceOf(mechanics), 0.2925 ether, "mechanics"); // 0.0975 * 3
        assertEq(weth.balanceOf(treasury), 0.2925 ether, "treasury");
        assertEq(vault.polReserveBalance(), 0.2925 ether, "pol reserve");
        assertEq(vault.filterEventCount(), 3, "event count");
        assertEq(vault.totalPolAccumulated(), 0.2925 ether, "pol cumulative");
        assertEq(vault.totalBountyAccumulated(), 0.075 ether, "bounty cumulative");
    }

    /// @notice POL is held as WETH; no winner-token purchase happens before submitWinner.
    function test_PolNotDeployedDuringWeek() public {
        _filterOne(loserA);
        _filterOne(loserB);

        // No winner tokens have been bought yet.
        assertEq(IERC20(winnerToken).balanceOf(address(vault)), 0);
        // POLManager hasn't been called yet either.
        assertEq(polManager.callCount(), 0);
        // POL reserve holds WETH only.
        SeasonPOLReserve r = vault.polReserve();
        assertEq(weth.balanceOf(address(r)), 0.195 ether); // 0.0975 * 2
        assertEq(r.deployed(), false);
    }

    // ============================================================ Final settlement

    function test_FullLifecycle_AccumulateThenDeploy() public {
        // Register a creator for the winner so the bounty actually pays out (vs. being
        // redirected to treasury — that's a separate test).
        creatorRegistry.set(winnerToken, winnerCreator);

        // Three filter events of 1 WETH each → 3 WETH total proceeds.
        _filterOne(loserA);
        _filterOne(loserB);
        _filterOne(loserC);

        (bytes32 leafA, bytes32 leafB) = _leaves();
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);
        _submit(root);

        // Rollover: 1.31625 WETH × 100_000 tokens/WETH = 131_625e18 tokens held by vault.
        assertEq(vault.rolloverWinnerTokens(), 131_625e18, "rollover tokens");
        assertEq(IERC20(winnerToken).balanceOf(address(vault)), 131_625e18);
        assertEq(vault.rolloverReserve(), 0, "rollover reserve drained");

        // Bonus: 0.73125 WETH funded into BonusDistributor.
        BonusDistributor.SeasonBonus memory b = bonus.bonusOf(1);
        assertEq(b.reserve, 0.731_25 ether, "bonus reserve");
        assertEq(b.winnerToken, winnerToken);
        assertEq(b.unlockTime, block.timestamp + 14 days);
        assertEq(weth.balanceOf(address(bonus)), 0.731_25 ether);
        assertEq(vault.bonusReserve(), 0, "bonus reserve drained");

        // POL: 0.2925 WETH delegated to the POLManager, which (per the mock) reports
        // 29_250e18 winner tokens at the configured mintRate and a fixed liquidity figure.
        assertEq(vault.polDeployedWeth(), 0.2925 ether);
        assertEq(vault.polDeployedTokens(), 29_250e18);
        assertEq(vault.polDeployedLiquidity(), 123, "polManager liquidity returned");
        assertEq(polManager.callCount(), 1, "polManager invoked once");
        assertEq(polManager.lastSender(), address(vault));
        assertEq(polManager.lastSeasonId(), 1);
        assertEq(polManager.lastWinner(), winnerToken);
        assertEq(polManager.lastWethAmount(), 0.2925 ether);
        assertEq(weth.balanceOf(address(polManager)), 0.2925 ether, "POLManager pulled WETH from vault");
        assertEq(vault.polReserveBalance(), 0, "pol reserve drained");
        assertEq(vault.polReserve().deployed(), true);

        // Mechanics + treasury were paid per-event, not at finalize.
        assertEq(weth.balanceOf(mechanics), 0.2925 ether);
        assertEq(weth.balanceOf(treasury), 0.2925 ether);

        // Champion bounty: 0.075 WETH paid out to winnerCreator.
        assertEq(weth.balanceOf(winnerCreator), 0.075 ether, "bounty paid to creator");
        assertEq(vault.bountyReserve(), 0, "bounty reserve drained");
        assertEq(vault.bountyPaid(), 0.075 ether, "bounty paid recorded");
        assertEq(vault.bountyRecipient(), winnerCreator);

        // Phase advanced.
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Distributing));
    }

    function test_RolloverClaim_Exact() public {
        creatorRegistry.set(winnerToken, winnerCreator);

        _filterOne(loserA);
        _filterOne(loserB);
        _filterOne(loserC);

        (bytes32 leafA, bytes32 leafB) = _leaves();
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);
        _submit(root);

        // Alice claims via Merkle proof. Share 50/80 of 131_625e18 = 82_265.625e18.
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(aliceUser);
        vault.claimRollover(ALICE_SHARE, proofA);
        assertEq(IERC20(winnerToken).balanceOf(aliceUser), 82_265.625e18);

        // Bob claims. Share 30/80 of 131_625e18 = 49_359.375e18.
        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(bobUser);
        vault.claimRollover(BOB_SHARE, proofB);
        assertEq(IERC20(winnerToken).balanceOf(bobUser), 49_359.375e18);

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

        // Only the 1 WETH from liquidation got the BPS split (with bounty off-the-top).
        assertEq(vault.bountyReserve(), 0.025 ether);
        assertEq(vault.rolloverReserve(), 0.438_75 ether);
        assertEq(vault.bonusReserve(), 0.243_75 ether);
        assertEq(weth.balanceOf(mechanics), 0.0975 ether);
        assertEq(weth.balanceOf(treasury), 0.0975 ether);
        assertEq(vault.polReserveBalance(), 0.0975 ether);

        // Pre-existing 1 WETH (trading fees) + bounty + rollover + bonus all still in vault.
        assertEq(weth.balanceOf(address(vault)), 1 ether + 0.025 ether + 0.438_75 ether + 0.243_75 ether);

        // submitWinner with no creator registered → bounty redirected to treasury, plus
        // trading-fee residue swept to treasury at the end. Treasury delta = 0.0975 (per-event)
        // + 0.025 (bounty redirect) + 1 (trading-fee residue) = 1.1225.
        _submit(bytes32(0));
        assertEq(weth.balanceOf(treasury), 1.1225 ether, "bounty + trading-fee residue swept to treasury");
        // Vault has only the rollover-bought winner tokens left.
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    // ============================================================ Champion bounty

    /// @notice Tournament registry is notified on every filter event (status → FILTERED) and
    ///         on submitWinner (status → WEEKLY_WINNER). Pins the multi-timescale qualification
    ///         hook into the existing weekly settlement path.
    function test_TournamentRegistry_NotifiedOnFilterAndWinner() public {
        creatorRegistry.set(winnerToken, winnerCreator);
        address[] memory cohort = new address[](2);
        cohort[0] = loserA;
        cohort[1] = loserB;
        _filter(cohort);
        assertEq(tournamentRegistry.filteredCount(loserA), 1);
        assertEq(tournamentRegistry.filteredCount(loserB), 1);
        assertEq(tournamentRegistry.filteredCount(loserC), 0);
        assertEq(tournamentRegistry.winnerCallCount(), 0, "no winner recorded yet");

        _submit(bytes32(0));
        assertEq(tournamentRegistry.winnerCallCount(), 1, "winner recorded at submit");
        (uint256 sid, address w) = tournamentRegistry.lastWinner();
        assertEq(sid, 1);
        assertEq(w, winnerToken);
    }

    /// @notice With a creator registered for the winner, the bounty pays out to that creator
    ///         and `bountyRecipient` records who received it. State drained.
    function test_Bounty_PaidToWinnerCreator() public {
        creatorRegistry.set(winnerToken, winnerCreator);
        _filterOne(loserA);
        _filterOne(loserB);
        // Each loser produces 1 WETH; bounty = 0.025 × 2 = 0.05.
        assertEq(vault.bountyReserve(), 0.05 ether);
        _submit(bytes32(0));
        assertEq(weth.balanceOf(winnerCreator), 0.05 ether, "creator got bounty");
        assertEq(vault.bountyReserve(), 0, "bounty drained");
        assertEq(vault.bountyPaid(), 0.05 ether);
        assertEq(vault.bountyRecipient(), winnerCreator);
    }

    /// @notice With NO creator registered for the winner (defensive path — shouldn't happen via
    ///         the launcher.launch path), the bounty is redirected to treasury rather than
    ///         silently lost.
    function test_Bounty_RedirectedWhenNoCreator() public {
        // creatorRegistry is left empty; winner has no creator.
        _filterOne(loserA);
        uint256 treasuryBefore = weth.balanceOf(treasury);
        _submit(bytes32(0));
        // Bounty = 0.025 ether; trading-fee residue = 0; per-event treasury slice = 0.0975
        // (already counted above). New treasury delta from submitWinner: 0.025 (bounty redirect).
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 0.025 ether, "bounty -> treasury");
        assertEq(vault.bountyRecipient(), address(0), "no recipient recorded");
        assertEq(vault.bountyPaid(), 0, "bountyPaid stays zero on redirect");
    }

    /// @notice Zero-proceeds events (all losers had drained pools) still increment event count
    ///         but produce no bounty.
    function test_Bounty_ZeroOnEmptyProceeds() public {
        // Drain the loser's mock locker so liquidation produces zero WETH.
        loserALocker.setLiquidationProceeds(0);
        _filterOne(loserA);
        assertEq(vault.bountyReserve(), 0);
        assertEq(vault.filterEventCount(), 1);
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

    /// @notice The single-shot guard now lives at the SeasonVault → POLManager seam: a second
    ///         submitWinner call reverts with WrongPhase before it ever reaches the manager.
    ///         This pins that contract; the POLManager itself doesn't need to defend against
    ///         per-season double-call because the season's phase machine already does.
    function test_PolDeployment_OnlyOnceViaWrongPhase() public {
        _filterOne(loserA);
        _submit(bytes32(0));
        assertEq(polManager.callCount(), 1, "manager called once");

        vm.prank(oracle);
        vm.expectRevert(SeasonVault.WrongPhase.selector);
        vault.submitWinner(winnerToken, bytes32(0), TOTAL_SHARES, 0, 0);
        assertEq(polManager.callCount(), 1, "still once after revert");
    }
}
