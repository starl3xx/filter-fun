// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {TournamentVault, ITournamentRegistryView, ICreatorRegistryView} from "../src/TournamentVault.sol";
import {TournamentRegistry} from "../src/TournamentRegistry.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";
import {MockCreatorRegistry} from "./mocks/MockCreatorRegistry.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MiniMerkle} from "./utils/MiniMerkle.sol";

/// @notice Auth + accounting + claim coverage for `TournamentVault`. The vault is the
///         on-chain settlement layer for the quarterly Filter Bowl: it accepts WETH
///         deposits per (year, quarter), splits 45/25/10/10/10 + 2.5% bounty at
///         settlement, and Merkle-proves rollover + bonus claims.
///
///         Tests use the **real** `TournamentRegistry` so the per-period membership
///         check (`isQuarterlyFinalist[year][quarter]`) is exercised end-to-end. The
///         launcher view is mocked because in production it's the deployed FilterLauncher;
///         here we just need `oracle()` + `tournamentVault()` + `vaultOf()` to return the
///         right things.
contract TournamentVaultTest is Test {
    TournamentVault vault;
    TournamentRegistry registry;
    MockLauncherView launcher;
    MockCreatorRegistry creatorRegistry;
    MockWETH weth;

    address oracle = makeAddr("oracle");
    address treasury = makeAddr("treasury");
    address mechanics = makeAddr("mechanics");
    address attacker = makeAddr("attacker");

    address tokenA = makeAddr("tokenA"); // weekly-winner / Q1 finalist + champion
    address tokenB = makeAddr("tokenB"); // weekly-winner / Q1 finalist (loser)
    address tokenC = makeAddr("tokenC"); // weekly-winner / Q1 finalist (loser)
    address creatorA = makeAddr("creatorA");

    address holderA = makeAddr("holderA");
    address holderB = makeAddr("holderB");
    address holderC = makeAddr("holderC");

    uint16 constant YEAR = 2026;
    uint8 constant QUARTER = 1;
    uint256 constant POT = 100 ether;
    uint256 constant BONUS_DELAY = 14 days;

    function setUp() public {
        weth = new MockWETH();
        launcher = new MockLauncherView();
        launcher.setOracle(oracle);
        registry = new TournamentRegistry(address(launcher));
        creatorRegistry = new MockCreatorRegistry();

        vault = new TournamentVault(
            address(launcher),
            address(weth),
            treasury,
            mechanics,
            ITournamentRegistryView(address(registry)),
            ICreatorRegistryView(address(creatorRegistry)),
            BONUS_DELAY
        );

        // Wire the registry's `recordQuarterlyChampion` auth to also accept the vault.
        launcher.setTournamentVault(address(vault));

        creatorRegistry.set(tokenA, creatorA);

        // Promote tokenA/B/C to WEEKLY_WINNER → QUARTERLY_FINALIST so registry checks pass.
        // We use season ids 1..3 with stand-in vault addresses.
        _stampWeeklyWinners();
        _enrollFinalists();
    }

    function _stampWeeklyWinners() internal {
        address[3] memory tokens = [tokenA, tokenB, tokenC];
        for (uint256 i = 0; i < 3; ++i) {
            uint256 sid = i + 1;
            address v = makeAddr(string(abi.encodePacked("seasonVault", vm.toString(sid))));
            launcher.setVault(sid, v);
            vm.prank(v);
            registry.recordWeeklyWinner(sid, tokens[i]);
        }
    }

    function _enrollFinalists() internal {
        address[] memory entrants = new address[](3);
        entrants[0] = tokenA;
        entrants[1] = tokenB;
        entrants[2] = tokenC;
        vm.prank(oracle);
        registry.recordQuarterlyFinalists(YEAR, QUARTER, entrants);
    }

    function _fund(address from, uint256 amount) internal {
        weth.mint(from, amount);
        vm.prank(from);
        weth.approve(address(vault), amount);
        vm.prank(from);
        vault.fundQuarterly(YEAR, QUARTER, amount);
    }

    // ============================================================ Funding

    function test_FundQuarterly_HappyPath() public {
        address funder = makeAddr("funder");
        _fund(funder, POT);

        TournamentVault.Tournament memory t = vault.tournamentOf(YEAR, QUARTER);
        assertEq(uint8(t.phase), uint8(TournamentVault.Phase.Open));
        assertEq(t.funded, POT);
        assertEq(weth.balanceOf(address(vault)), POT);
    }

    function test_FundQuarterly_AccumulatesAcrossDeposits() public {
        address funder = makeAddr("funder");
        _fund(funder, 30 ether);
        _fund(funder, 70 ether);
        TournamentVault.Tournament memory t = vault.tournamentOf(YEAR, QUARTER);
        assertEq(t.funded, 100 ether);
        assertEq(uint8(t.phase), uint8(TournamentVault.Phase.Open));
    }

    function test_FundQuarterly_RejectsBadQuarter() public {
        weth.mint(address(this), 1 ether);
        weth.approve(address(vault), 1 ether);
        vm.expectRevert(TournamentVault.BadQuarter.selector);
        vault.fundQuarterly(YEAR, 0, 1 ether);
        vm.expectRevert(TournamentVault.BadQuarter.selector);
        vault.fundQuarterly(YEAR, 5, 1 ether);
    }

    function test_FundQuarterly_RejectsZeroAmount() public {
        vm.expectRevert(TournamentVault.ZeroAmount.selector);
        vault.fundQuarterly(YEAR, QUARTER, 0);
    }

    function test_FundQuarterly_RejectsAfterSettlement() public {
        _fund(makeAddr("funder"), POT);
        bytes32[] memory empty;
        bytes32 rolloverRoot = bytes32(uint256(1));
        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, rolloverRoot, 1, bytes32(0), 0);
        // Tournament is now Settled → fund call must revert.
        weth.mint(address(this), 1 ether);
        weth.approve(address(vault), 1 ether);
        vm.expectRevert(TournamentVault.WrongPhase.selector);
        vault.fundQuarterly(YEAR, QUARTER, 1 ether);
        empty; // silence unused
    }

    // ============================================================ Settlement auth + validation

    function test_SubmitQuarterlyWinner_OnlyOracle() public {
        _fund(makeAddr("funder"), POT);
        vm.prank(attacker);
        vm.expectRevert(TournamentVault.NotOracle.selector);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(0), 1, bytes32(0), 0);
    }

    function test_SubmitQuarterlyWinner_RejectsBadQuarter() public {
        _fund(makeAddr("funder"), POT);
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.BadQuarter.selector);
        vault.submitQuarterlyWinner(YEAR, 0, tokenA, bytes32(0), 1, bytes32(0), 0);
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.BadQuarter.selector);
        vault.submitQuarterlyWinner(YEAR, 5, tokenA, bytes32(0), 1, bytes32(0), 0);
    }

    function test_SubmitQuarterlyWinner_RejectsZeroWinner() public {
        _fund(makeAddr("funder"), POT);
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.BadWinner.selector);
        vault.submitQuarterlyWinner(YEAR, QUARTER, address(0), bytes32(0), 1, bytes32(0), 0);
    }

    function test_SubmitQuarterlyWinner_RejectsZeroShares() public {
        _fund(makeAddr("funder"), POT);
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.ZeroShares.selector);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(0), 0, bytes32(0), 0);
    }

    function test_SubmitQuarterlyWinner_RejectsEmptyPot() public {
        // Tournament is Idle (never funded) → settlement must revert.
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.EmptyPot.selector);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(0), 1, bytes32(0), 0);
    }

    function test_SubmitQuarterlyWinner_RejectsNonFinalist() public {
        // tokenD is not in the (year, quarter) finalist list.
        address tokenD = makeAddr("tokenD");
        creatorRegistry.set(tokenD, makeAddr("creatorD"));
        _fund(makeAddr("funder"), POT);
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.WinnerNotFinalist.selector);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenD, bytes32(0), 1, bytes32(0), 0);
    }

    function test_SubmitQuarterlyWinner_RejectsCrossPeriodFinalist() public {
        // tokenA is finalist in Q1 only — Q2 settlement must reject it even though
        // tokenA's status is QUARTERLY_FINALIST. This is the per-period membership
        // guard inherited from PR #25 (bugbot Medium #2).
        _fund(makeAddr("funder"), POT);
        // Note: settlement is keyed by (year, quarter); we set up the call against Q2.
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.EmptyPot.selector); // Q2 has no pot
        vault.submitQuarterlyWinner(YEAR, 2, tokenA, bytes32(0), 1, bytes32(0), 0);

        // Fund Q2 explicitly and re-attempt — registry should reject tokenA (not a Q2 finalist).
        weth.mint(address(this), POT);
        weth.approve(address(vault), POT);
        vault.fundQuarterly(YEAR, 2, POT);

        vm.prank(oracle);
        vm.expectRevert(TournamentVault.WinnerNotFinalist.selector);
        vault.submitQuarterlyWinner(YEAR, 2, tokenA, bytes32(0), 1, bytes32(0), 0);
    }

    function test_SubmitQuarterlyWinner_RejectsDouble() public {
        _fund(makeAddr("funder"), POT);
        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, bytes32(0), 0);
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.AlreadySettled.selector);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, bytes32(0), 0);
    }

    // ============================================================ Settlement accounting

    function test_SubmitQuarterlyWinner_Distribution() public {
        _fund(makeAddr("funder"), POT);

        bytes32 rollRoot = bytes32(uint256(0xCAFE));
        bytes32 bonusRoot = bytes32(uint256(0xBEEF));

        uint256 creatorBefore = weth.balanceOf(creatorA);
        uint256 mechanicsBefore = weth.balanceOf(mechanics);
        uint256 treasuryBefore = weth.balanceOf(treasury);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, rollRoot, 100, bonusRoot, 25 ether);

        // Expected math on POT = 100e18:
        //   bounty = 2.5%        = 2.5e18
        //   remainder = 97.5e18
        //   rollover = 45% * remainder = 43.875e18
        //   bonus    = 25% * remainder = 24.375e18
        //   mechanics= 10% * remainder = 9.75e18
        //   pol      = 10% * remainder = 9.75e18
        //   treasury = remainder - rest = 9.75e18 (rounding dust = 0 here)
        assertEq(weth.balanceOf(creatorA) - creatorBefore, 2.5 ether);
        assertEq(weth.balanceOf(mechanics) - mechanicsBefore, 9.75 ether);
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 9.75 ether);

        TournamentVault.Tournament memory t = vault.tournamentOf(YEAR, QUARTER);
        assertEq(uint8(t.phase), uint8(TournamentVault.Phase.Settled));
        assertEq(t.winner, tokenA);
        assertEq(t.bountyAmount, 2.5 ether);
        assertEq(t.bountyCreator, creatorA);
        assertEq(t.rolloverReserve, 43.875 ether);
        assertEq(t.bonusReserve, 24.375 ether);
        assertEq(t.polAccumulated, 9.75 ether);
        assertEq(t.rolloverRoot, rollRoot);
        assertEq(t.totalRolloverShares, 100);
        assertEq(t.bonusRoot, bonusRoot);
        assertEq(t.totalBonusAmount, 25 ether);
        assertEq(t.bonusUnlockTime, block.timestamp + BONUS_DELAY);

        // Vault should still hold rollover + bonus + POL slice.
        assertEq(weth.balanceOf(address(vault)), 43.875 ether + 24.375 ether + 9.75 ether);

        // Registry stamped QUARTERLY_CHAMPION on tokenA.
        assertEq(registry.quarterlyChampionOf(YEAR, QUARTER), tokenA);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.QUARTERLY_CHAMPION));
    }

    function test_SubmitQuarterlyWinner_BountyRedirectsWhenNoCreator() public {
        // tokenC has no creator registered — bounty should redirect to treasury.
        _fund(makeAddr("funder"), POT);
        uint256 treasuryBefore = weth.balanceOf(treasury);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenC, bytes32(uint256(1)), 1, bytes32(0), 0);

        // 2.5e18 bounty + 9.75e18 treasury slice = 12.25e18 total to treasury.
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 12.25 ether);

        TournamentVault.Tournament memory t = vault.tournamentOf(YEAR, QUARTER);
        assertEq(t.bountyCreator, address(0));
    }

    function test_SubmitQuarterlyWinner_PolAccumulatesUntilDeployment() public {
        // POL slice is intentionally parked in the vault as WETH for genesis (deployment
        // path is a follow-up PR). The pendingPolBalance view should expose it.
        _fund(makeAddr("funder"), POT);
        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, bytes32(0), 0);
        assertEq(vault.pendingPolBalance(YEAR, QUARTER), 9.75 ether);
    }

    // ============================================================ Rollover claims

    function _buildSimpleRolloverTree(address user1, uint256 share1, address user2, uint256 share2)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof1, bytes32[] memory proof2)
    {
        bytes32[2] memory leaves;
        leaves[0] = keccak256(abi.encodePacked(user1, share1));
        leaves[1] = keccak256(abi.encodePacked(user2, share2));
        root = MiniMerkle.rootOfTwo(leaves[0], leaves[1]);
        proof1 = MiniMerkle.proofForTwo(leaves, 0);
        proof2 = MiniMerkle.proofForTwo(leaves, 1);
    }

    function test_ClaimQuarterlyRollover_HappyPath() public {
        _fund(makeAddr("funder"), POT);

        (bytes32 root, bytes32[] memory pA, bytes32[] memory pB) =
            _buildSimpleRolloverTree(holderA, 70, holderB, 30);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, root, 100, bytes32(0), 0);

        // rollover reserve = 43.875e18; holderA gets 70% = 30.7125e18, holderB gets 13.1625e18.
        vm.prank(holderA);
        vault.claimQuarterlyRollover(YEAR, QUARTER, 70, pA);
        assertEq(weth.balanceOf(holderA), 30.7125 ether);

        vm.prank(holderB);
        vault.claimQuarterlyRollover(YEAR, QUARTER, 30, pB);
        assertEq(weth.balanceOf(holderB), 13.1625 ether);

        TournamentVault.Tournament memory t = vault.tournamentOf(YEAR, QUARTER);
        assertEq(t.claimedRolloverShares, 100);
    }

    function test_ClaimQuarterlyRollover_RejectsBadProof() public {
        _fund(makeAddr("funder"), POT);
        (bytes32 root,, bytes32[] memory pB) = _buildSimpleRolloverTree(holderA, 70, holderB, 30);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, root, 100, bytes32(0), 0);

        // holderA tries to claim with holderB's proof — must revert.
        vm.prank(holderA);
        vm.expectRevert(TournamentVault.InvalidProof.selector);
        vault.claimQuarterlyRollover(YEAR, QUARTER, 70, pB);
    }

    function test_ClaimQuarterlyRollover_RejectsDouble() public {
        _fund(makeAddr("funder"), POT);
        (bytes32 root, bytes32[] memory pA,) = _buildSimpleRolloverTree(holderA, 70, holderB, 30);
        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, root, 100, bytes32(0), 0);

        vm.prank(holderA);
        vault.claimQuarterlyRollover(YEAR, QUARTER, 70, pA);
        vm.prank(holderA);
        vm.expectRevert(TournamentVault.AlreadyClaimed.selector);
        vault.claimQuarterlyRollover(YEAR, QUARTER, 70, pA);
    }

    function test_ClaimQuarterlyRollover_RejectsBeforeSettlement() public {
        _fund(makeAddr("funder"), POT);
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(TournamentVault.WrongPhase.selector);
        vault.claimQuarterlyRollover(YEAR, QUARTER, 1, empty);
    }

    // ============================================================ Bonus claims

    function test_ClaimQuarterlyBonus_HappyPath() public {
        _fund(makeAddr("funder"), POT);
        (bytes32 root, bytes32[] memory pA,) = _buildSimpleRolloverTree(holderA, 1 ether, holderB, 0.5 ether);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, root, 1.5 ether);

        vm.warp(block.timestamp + BONUS_DELAY);
        vm.prank(holderA);
        vault.claimQuarterlyBonus(YEAR, QUARTER, 1 ether, pA);
        assertEq(weth.balanceOf(holderA), 1 ether);
    }

    function test_ClaimQuarterlyBonus_RejectsBeforeUnlock() public {
        _fund(makeAddr("funder"), POT);
        (bytes32 root, bytes32[] memory pA,) = _buildSimpleRolloverTree(holderA, 1 ether, holderB, 0.5 ether);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, root, 1.5 ether);

        vm.prank(holderA);
        vm.expectRevert(TournamentVault.BonusLocked.selector);
        vault.claimQuarterlyBonus(YEAR, QUARTER, 1 ether, pA);
    }

    function test_ClaimQuarterlyBonus_RejectsBadProof() public {
        _fund(makeAddr("funder"), POT);
        (bytes32 root,, bytes32[] memory pB) = _buildSimpleRolloverTree(holderA, 1 ether, holderB, 0.5 ether);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, root, 1.5 ether);

        vm.warp(block.timestamp + BONUS_DELAY);
        vm.prank(holderA);
        vm.expectRevert(TournamentVault.InvalidProof.selector);
        vault.claimQuarterlyBonus(YEAR, QUARTER, 1 ether, pB);
    }

    function test_ClaimQuarterlyBonus_RejectsDouble() public {
        _fund(makeAddr("funder"), POT);
        (bytes32 root, bytes32[] memory pA,) = _buildSimpleRolloverTree(holderA, 1 ether, holderB, 0.5 ether);

        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, root, 1.5 ether);

        vm.warp(block.timestamp + BONUS_DELAY);
        vm.prank(holderA);
        vault.claimQuarterlyBonus(YEAR, QUARTER, 1 ether, pA);
        vm.prank(holderA);
        vm.expectRevert(TournamentVault.AlreadyClaimed.selector);
        vault.claimQuarterlyBonus(YEAR, QUARTER, 1 ether, pA);
    }

    // ============================================================ Oracle rotation

    /// @notice Same regression as TournamentRegistry's oracle-rotation test: settlement
    ///         auth follows `launcher.oracle()` dynamically. The new oracle must be able
    ///         to settle a tournament immediately after a rotation.
    function test_OracleRotation_NewOracleCanSettle() public {
        _fund(makeAddr("funder"), POT);
        address newOracle = makeAddr("newOracle");
        launcher.setOracle(newOracle);

        // Old oracle no longer authorized.
        vm.prank(oracle);
        vm.expectRevert(TournamentVault.NotOracle.selector);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, bytes32(0), 0);

        vm.prank(newOracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, bytes32(0), 0);

        TournamentVault.Tournament memory t = vault.tournamentOf(YEAR, QUARTER);
        assertEq(t.winner, tokenA);
    }

    // ============================================================ Independent (year, quarter) state

    /// @notice State for one (year, quarter) tournament must not leak into another.
    ///         Settling Q1 should leave Q2 untouched.
    function test_PerPeriodIsolation() public {
        _fund(makeAddr("funder"), POT);
        vm.prank(oracle);
        vault.submitQuarterlyWinner(YEAR, QUARTER, tokenA, bytes32(uint256(1)), 1, bytes32(0), 0);

        TournamentVault.Tournament memory q2 = vault.tournamentOf(YEAR, 2);
        assertEq(uint8(q2.phase), uint8(TournamentVault.Phase.Idle));
        assertEq(q2.funded, 0);
        assertEq(q2.winner, address(0));
    }
}
