// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {TournamentRegistry} from "../src/TournamentRegistry.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";

/// @notice Auth + status-ladder coverage for TournamentRegistry. The contract has no funds;
///         every test exercises the metadata transitions:
///         - SeasonVault hooks: recordWeeklyWinner / markFiltered (gated to launcher.vaultOf)
///         - Oracle hooks: quarterly + annual finalists / champions (gated to oracle)
///         - Status ladder: ACTIVE → FILTERED (terminal) and ACTIVE → WEEKLY_WINNER →
///           QUARTERLY_FINALIST → QUARTERLY_CHAMPION → ANNUAL_FINALIST → ANNUAL_CHAMPION
///         - Qualification view: `qualifiedFor(token, level)` mirrors the ladder
contract TournamentRegistryTest is Test {
    TournamentRegistry registry;
    MockLauncherView launcher;

    address oracle = makeAddr("oracle");
    address realVault = makeAddr("realVault");
    address attacker = makeAddr("attacker");
    address tokenA = makeAddr("tokenA");
    address tokenB = makeAddr("tokenB");
    address tokenC = makeAddr("tokenC");
    address tokenD = makeAddr("tokenD");

    uint256 constant SEASON = 1;

    function setUp() public {
        launcher = new MockLauncherView();
        launcher.setOracle(oracle);
        registry = new TournamentRegistry(address(launcher));
        launcher.setVault(SEASON, realVault);
    }

    // ============================================================ recordWeeklyWinner

    function test_RecordWeeklyWinner_OnlyRegisteredVault() public {
        vm.prank(attacker);
        vm.expectRevert(TournamentRegistry.NotRegisteredVault.selector);
        registry.recordWeeklyWinner(SEASON, tokenA);
    }

    function test_RecordWeeklyWinner_RejectsZero() public {
        vm.prank(realVault);
        vm.expectRevert(TournamentRegistry.ZeroToken.selector);
        registry.recordWeeklyWinner(SEASON, address(0));
    }

    function test_RecordWeeklyWinner_HappyPath() public {
        vm.prank(realVault);
        registry.recordWeeklyWinner(SEASON, tokenA);

        assertEq(registry.weeklyWinnerOf(SEASON), tokenA);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.WEEKLY_WINNER));
        address[] memory winners = registry.getWeeklyWinners();
        assertEq(winners.length, 1);
        assertEq(winners[0], tokenA);
    }

    function test_RecordWeeklyWinner_RejectsDouble() public {
        vm.prank(realVault);
        registry.recordWeeklyWinner(SEASON, tokenA);
        vm.prank(realVault);
        vm.expectRevert(TournamentRegistry.AlreadyRecorded.selector);
        registry.recordWeeklyWinner(SEASON, tokenA);
    }

    function test_RecordWeeklyWinner_AccumulatesAcrossSeasons() public {
        address vault2 = makeAddr("vault2");
        launcher.setVault(2, vault2);

        vm.prank(realVault);
        registry.recordWeeklyWinner(1, tokenA);
        vm.prank(vault2);
        registry.recordWeeklyWinner(2, tokenB);

        address[] memory winners = registry.getWeeklyWinners();
        assertEq(winners.length, 2);
        assertEq(winners[0], tokenA);
        assertEq(winners[1], tokenB);
        assertEq(registry.weeklyWinnerCount(), 2);
    }

    /// @notice FILTERED is terminal. A token that's been filtered cannot later be recorded as
    ///         a weekly winner — registry rejects to keep its mappings + array state
    ///         consistent with the qualification view (bugbot Low #3).
    function test_RecordWeeklyWinner_RejectsFilteredToken() public {
        vm.prank(realVault);
        registry.markFiltered(SEASON, tokenA);
        // Open a second season; same token cannot win.
        address vault2 = makeAddr("vault2");
        launcher.setVault(2, vault2);
        vm.prank(vault2);
        vm.expectRevert(TournamentRegistry.NotEligible.selector);
        registry.recordWeeklyWinner(2, tokenA);
        // Mappings + array stay clean.
        assertEq(registry.weeklyWinnerOf(2), address(0));
        assertEq(registry.weeklyWinnerCount(), 0);
    }

    /// @notice A token that already holds a higher title (e.g. the same address somehow won
    ///         both a weekly and is currently a quarterly finalist) keeps its better status.
    ///         Defensive — shouldn't actually happen in practice.
    function test_RecordWeeklyWinner_DoesNotDowngradeHigherTitle() public {
        // Manually elevate tokenA via the full ladder.
        vm.prank(realVault);
        registry.recordWeeklyWinner(SEASON, tokenA);
        address[] memory ents = new address[](1);
        ents[0] = tokenA;
        vm.prank(oracle);
        registry.recordQuarterlyFinalists(2026, 1, ents);
        // tokenA is now QUARTERLY_FINALIST.

        // Open a new season and "re-win" tokenA. Status should NOT regress.
        address vault2 = makeAddr("vault2");
        launcher.setVault(2, vault2);
        vm.prank(vault2);
        registry.recordWeeklyWinner(2, tokenA);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.QUARTERLY_FINALIST));
    }

    // ============================================================ markFiltered

    function test_MarkFiltered_OnlyRegisteredVault() public {
        vm.prank(attacker);
        vm.expectRevert(TournamentRegistry.NotRegisteredVault.selector);
        registry.markFiltered(SEASON, tokenA);
    }

    function test_MarkFiltered_HappyPath() public {
        vm.prank(realVault);
        registry.markFiltered(SEASON, tokenA);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.FILTERED));
    }

    /// @notice Tokens that already hold a non-ACTIVE status (e.g. a past WEEKLY_WINNER) are
    ///         not regressed to FILTERED — `markFiltered` no-ops in that case.
    function test_MarkFiltered_NoOpOnNonActive() public {
        vm.prank(realVault);
        registry.recordWeeklyWinner(SEASON, tokenA);
        vm.prank(realVault);
        registry.markFiltered(SEASON, tokenA);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.WEEKLY_WINNER));
    }

    // ============================================================ Quarterly hooks

    function _stampWeeklyWinners(address[] memory tokens) internal {
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 sid = i + 1;
            address v = makeAddr(string(abi.encodePacked("vault", vm.toString(sid))));
            launcher.setVault(sid, v);
            vm.prank(v);
            registry.recordWeeklyWinner(sid, tokens[i]);
        }
    }

    function test_RecordQuarterlyFinalists_OnlyOracle() public {
        address[] memory ents = new address[](1);
        ents[0] = tokenA;
        vm.prank(attacker);
        vm.expectRevert(TournamentRegistry.NotOracle.selector);
        registry.recordQuarterlyFinalists(2026, 1, ents);
    }

    function test_RecordQuarterlyFinalists_RequiresWeeklyWinnerStatus() public {
        // tokenA hasn't won a weekly — oracle's attempt to enroll it as a quarterly finalist
        // must revert. This is the qualification-ladder enforcement.
        address[] memory ents = new address[](1);
        ents[0] = tokenA;
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.NotEligible.selector);
        registry.recordQuarterlyFinalists(2026, 1, ents);
    }

    function test_RecordQuarterlyFinalists_HappyPath() public {
        address[] memory winners = new address[](2);
        winners[0] = tokenA;
        winners[1] = tokenB;
        _stampWeeklyWinners(winners);

        vm.prank(oracle);
        registry.recordQuarterlyFinalists(2026, 1, winners);

        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.QUARTERLY_FINALIST));
        assertEq(uint8(registry.statusOf(tokenB)), uint8(TournamentRegistry.TokenStatus.QUARTERLY_FINALIST));
        address[] memory got = registry.getQuarterlyFinalists(2026, 1);
        assertEq(got.length, 2);
        assertEq(got[0], tokenA);
        assertEq(got[1], tokenB);
    }

    function test_RecordQuarterlyFinalists_RejectsDouble() public {
        address[] memory winners = new address[](1);
        winners[0] = tokenA;
        _stampWeeklyWinners(winners);
        vm.prank(oracle);
        registry.recordQuarterlyFinalists(2026, 1, winners);
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.AlreadyRecorded.selector);
        registry.recordQuarterlyFinalists(2026, 1, winners);
    }

    function test_RecordQuarterlyFinalists_RejectsEmpty() public {
        address[] memory empty = new address[](0);
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.EmptyEntrants.selector);
        registry.recordQuarterlyFinalists(2026, 1, empty);
    }

    function test_RecordQuarterlyChampion_HappyPath() public {
        address[] memory winners = new address[](2);
        winners[0] = tokenA;
        winners[1] = tokenB;
        _stampWeeklyWinners(winners);
        vm.prank(oracle);
        registry.recordQuarterlyFinalists(2026, 1, winners);

        vm.prank(oracle);
        registry.recordQuarterlyChampion(2026, 1, tokenA);
        assertEq(registry.quarterlyChampionOf(2026, 1), tokenA);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.QUARTERLY_CHAMPION));
        // Runner-up keeps QUARTERLY_FINALIST.
        assertEq(uint8(registry.statusOf(tokenB)), uint8(TournamentRegistry.TokenStatus.QUARTERLY_FINALIST));
    }

    function test_RecordQuarterlyChampion_RejectsNonFinalist() public {
        // tokenA hasn't been recorded as a quarterly finalist.
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.NotEligible.selector);
        registry.recordQuarterlyChampion(2026, 1, tokenA);
    }

    /// @notice Regression: a runner-up from Q1 retains QUARTERLY_FINALIST status indefinitely.
    ///         A status-only check would let the oracle illegitimately crown that runner-up
    ///         as Q2 champion (where they never competed). Per-period membership flag prevents
    ///         this — bugbot Medium #2.
    function test_RecordQuarterlyChampion_RejectsCrossPeriodFinalist() public {
        // Q1: tokenA + tokenB compete; tokenA wins, tokenB is runner-up but keeps
        // QUARTERLY_FINALIST status.
        address[] memory q1Winners = new address[](2);
        q1Winners[0] = tokenA;
        q1Winners[1] = tokenB;
        _stampWeeklyWinners(q1Winners);
        vm.prank(oracle);
        registry.recordQuarterlyFinalists(2026, 1, q1Winners);
        vm.prank(oracle);
        registry.recordQuarterlyChampion(2026, 1, tokenA);
        // tokenB still QUARTERLY_FINALIST — but ONLY for Q1, never enrolled in Q2.

        // Oracle attempts to crown tokenB as Q2 champion — must revert because tokenB is
        // not in `isQuarterlyFinalist[2026][2]`.
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.NotEligible.selector);
        registry.recordQuarterlyChampion(2026, 2, tokenB);
    }

    function test_RecordQuarterlyChampion_RejectsDouble() public {
        address[] memory winners = new address[](2);
        winners[0] = tokenA;
        winners[1] = tokenB;
        _stampWeeklyWinners(winners);
        vm.prank(oracle);
        registry.recordQuarterlyFinalists(2026, 1, winners);
        vm.prank(oracle);
        registry.recordQuarterlyChampion(2026, 1, tokenA);
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.AlreadyFinalized.selector);
        registry.recordQuarterlyChampion(2026, 1, tokenB);
    }

    // ============================================================ Annual hooks

    /// @dev Helper: drive 4 tokens all the way to QUARTERLY_CHAMPION across quarters 1-4.
    function _crownFourQuarterlyChampions() internal {
        address[4] memory champs = [tokenA, tokenB, tokenC, tokenD];
        for (uint256 i = 0; i < 4; ++i) {
            uint256 sid = i + 1;
            address v = makeAddr(string(abi.encodePacked("vault", vm.toString(sid))));
            launcher.setVault(sid, v);
            vm.prank(v);
            registry.recordWeeklyWinner(sid, champs[i]);

            address[] memory ents = new address[](1);
            ents[0] = champs[i];
            vm.prank(oracle);
            registry.recordQuarterlyFinalists(2026, uint8(i + 1), ents);
            vm.prank(oracle);
            registry.recordQuarterlyChampion(2026, uint8(i + 1), champs[i]);
        }
    }

    /// @notice Annual finalists are read directly from `quarterlyChampionOf[year][1..4]`.
    ///         If any quarter for the requested year lacks a recorded champion, the call
    ///         reverts with `WrongQuarterCount`. Replaces the old "requires exactly four"
    ///         + "requires QUARTERLY_CHAMPION status" pair: with the entrant array gone,
    ///         both invariants collapse to a single per-year storage check (bugbot Medium).
    function test_RecordAnnualFinalists_RequiresAllFourQuartersFilled() public {
        // Only 3 quarters get champions — 2026 q4 is left empty.
        address[3] memory champs = [tokenA, tokenB, tokenC];
        for (uint256 i = 0; i < 3; ++i) {
            uint256 sid = i + 1;
            address v = makeAddr(string(abi.encodePacked("vault", vm.toString(sid))));
            launcher.setVault(sid, v);
            vm.prank(v);
            registry.recordWeeklyWinner(sid, champs[i]);

            address[] memory ents = new address[](1);
            ents[0] = champs[i];
            vm.prank(oracle);
            registry.recordQuarterlyFinalists(2026, uint8(i + 1), ents);
            vm.prank(oracle);
            registry.recordQuarterlyChampion(2026, uint8(i + 1), champs[i]);
        }

        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.WrongQuarterCount.selector);
        registry.recordAnnualFinalists(2026);
    }

    /// @notice Regression: enrolling annual finalists for a year with NO recorded quarterly
    ///         champions reverts even when a different year is fully populated. Prevents the
    ///         oracle from accidentally opening an annual for the wrong calendar year — the
    ///         entrant list is per-year by storage construction, not by oracle-supplied input.
    function test_RecordAnnualFinalists_RejectsCrossYearChampions() public {
        // Populate 2026's four quarters fully.
        _crownFourQuarterlyChampions();
        // 2027 has no quarterly champions yet.
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.WrongQuarterCount.selector);
        registry.recordAnnualFinalists(2027);
    }

    function test_AnnualHappyPath() public {
        _crownFourQuarterlyChampions();
        vm.prank(oracle);
        registry.recordAnnualFinalists(2026);
        address[4] memory expected = [tokenA, tokenB, tokenC, tokenD];
        address[] memory got = registry.getAnnualFinalists(2026);
        assertEq(got.length, 4);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(got[i], expected[i]);
            assertEq(
                uint8(registry.statusOf(expected[i])), uint8(TournamentRegistry.TokenStatus.ANNUAL_FINALIST)
            );
            assertTrue(registry.isAnnualFinalist(2026, expected[i]));
        }

        vm.prank(oracle);
        registry.recordAnnualChampion(2026, tokenA);
        assertEq(registry.annualChampionOf(2026), tokenA);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.ANNUAL_CHAMPION));
    }

    function test_RecordAnnualFinalists_RejectsDouble() public {
        _crownFourQuarterlyChampions();
        vm.prank(oracle);
        registry.recordAnnualFinalists(2026);
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.AlreadyRecorded.selector);
        registry.recordAnnualFinalists(2026);
    }

    function test_RecordAnnualChampion_RejectsNonFinalist() public {
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.NotEligible.selector);
        registry.recordAnnualChampion(2026, tokenA);
    }

    /// @notice Annual counterpart of the cross-period regression: a 2026 finalist (with
    ///         status ANNUAL_FINALIST) cannot be crowned 2027 champion. Per-year membership
    ///         flag is the gate.
    function test_RecordAnnualChampion_RejectsCrossYearFinalist() public {
        _crownFourQuarterlyChampions();
        vm.prank(oracle);
        registry.recordAnnualFinalists(2026);
        // tokenA is now ANNUAL_FINALIST (for 2026). Oracle attempts to crown it 2027
        // champion — must revert.
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.NotEligible.selector);
        registry.recordAnnualChampion(2027, tokenA);
    }

    // ============================================================ Oracle rotation

    /// @notice Regression: registry's onlyOracle modifier reads `launcher.oracle()`
    ///         dynamically rather than caching at construction. After the launcher rotates
    ///         its oracle, the new oracle must be able to call quarterly/annual record
    ///         functions immediately — bugbot Medium #1.
    function test_OracleRotation_NewOracleCanRecord() public {
        address newOracle = makeAddr("newOracle");
        launcher.setOracle(newOracle);
        // Old oracle is no longer authorized.
        vm.prank(oracle);
        vm.expectRevert(TournamentRegistry.NotOracle.selector);
        registry.recordQuarterlyFinalists(2026, 1, new address[](0));

        // New oracle drives a weekly winner in directly (mocked).
        vm.prank(realVault);
        registry.recordWeeklyWinner(SEASON, tokenA);
        // New oracle records quarterly finalist successfully.
        address[] memory ents = new address[](1);
        ents[0] = tokenA;
        vm.prank(newOracle);
        registry.recordQuarterlyFinalists(2026, 1, ents);
        assertEq(uint8(registry.statusOf(tokenA)), uint8(TournamentRegistry.TokenStatus.QUARTERLY_FINALIST));
        // The view also reflects the rotation.
        assertEq(registry.oracle(), newOracle);
    }

    // ============================================================ Qualification view

    function test_QualifiedFor_Active() public view {
        // Default ACTIVE → qualifies for WEEKLY (open registration).
        assertTrue(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.WEEKLY));
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.QUARTERLY));
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.ANNUAL));
    }

    function test_QualifiedFor_Filtered() public {
        vm.prank(realVault);
        registry.markFiltered(SEASON, tokenA);
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.WEEKLY));
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.QUARTERLY));
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.ANNUAL));
    }

    function test_QualifiedFor_WeeklyWinner() public {
        vm.prank(realVault);
        registry.recordWeeklyWinner(SEASON, tokenA);
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.WEEKLY));
        assertTrue(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.QUARTERLY));
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.ANNUAL));
    }

    function test_QualifiedFor_QuarterlyChampion() public {
        address[] memory winners = new address[](1);
        winners[0] = tokenA;
        _stampWeeklyWinners(winners);
        vm.prank(oracle);
        registry.recordQuarterlyFinalists(2026, 1, winners);
        vm.prank(oracle);
        registry.recordQuarterlyChampion(2026, 1, tokenA);

        assertTrue(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.ANNUAL));
        // No longer eligible to re-enter quarterly (already champion).
        assertFalse(registry.qualifiedFor(tokenA, TournamentRegistry.CompetitionLevel.QUARTERLY));
    }
}
