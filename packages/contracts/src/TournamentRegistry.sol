// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ILauncherViewTR {
    function vaultOf(uint256 seasonId) external view returns (address);
    function oracle() external view returns (address);
    function tournamentVault() external view returns (address);
}

/// @title TournamentRegistry
/// @notice Singleton metadata layer for filter.fun's multi-timescale championship structure:
///
///         Weekly seasons → Quarterly Filter Bowl → Annual Championship
///
///         This contract is the **registry only** — it tracks token status (ACTIVE / FILTERED /
///         WEEKLY_WINNER / QUARTERLY_FINALIST / QUARTERLY_CHAMPION / ANNUAL_FINALIST /
///         ANNUAL_CHAMPION) plus the historical lists the oracle/UI need to determine
///         qualification.
///
///         **Tournament settlement is NOT in this contract.** Quarterly + annual pot
///         accounting, distribution (45/25/10/10/10), POL deployment, etc. live in a separate
///         TournamentVault (next PR). The deliberate split:
///         - this contract is read-mostly + cheap to write to (no fund movement)
///         - settlement contracts can read from here without the registry having to know
///           about pots, oracles, or distribution arithmetic
///         - **organic LP on weekly winners is never touched by this contract**, satisfying
///           the user-aligned "tournaments do not unwind established markets" principle. The
///           registry just labels.
///
///         Auth model:
///         - `recordWeeklyWinner` / `markFiltered` are gated to the launcher's registered
///           SeasonVault for the given seasonId (same pattern as POLManager.deployPOL).
///         - `recordQuarterlyFinalists` / `recordQuarterlyChampion` /
///           `recordAnnualFinalists` / `recordAnnualChampion` are gated to the oracle. They
///           validate that each entrant has the prerequisite status (e.g. quarterly finalists
///           must be WEEKLY_WINNER first). Tournament settlement contracts will be the
///           on-chain caller in a follow-up PR; in genesis the oracle multisig calls directly.
contract TournamentRegistry {
    enum CompetitionLevel {
        WEEKLY,
        QUARTERLY,
        ANNUAL
    }

    /// @dev Status is monotonic in the "best title earned" direction:
    ///      ACTIVE < FILTERED (terminal failure) and ACTIVE < WEEKLY_WINNER < QUARTERLY_FINALIST
    ///      < QUARTERLY_CHAMPION < ANNUAL_FINALIST < ANNUAL_CHAMPION. Once a token is FILTERED
    ///      it cannot be elevated; once it has a winning title it can't regress to FILTERED.
    enum TokenStatus {
        ACTIVE,
        FILTERED,
        WEEKLY_WINNER,
        QUARTERLY_FINALIST,
        QUARTERLY_CHAMPION,
        ANNUAL_FINALIST,
        ANNUAL_CHAMPION
    }

    address public immutable launcher;

    /// @notice Per-token status. Defaults to ACTIVE (zero) for any token never seen — caller
    ///         disambiguates via the launcher's `entryOf` / `creatorRegistry` if they need to
    ///         distinguish "never registered" from "active".
    mapping(address => TokenStatus) public statusOf;

    /// @notice Per-season weekly-winner record. Set once when the SeasonVault calls
    ///         `recordWeeklyWinner` from inside `submitWinner`. Zero address for seasons that
    ///         haven't finalized yet.
    mapping(uint256 => address) public weeklyWinnerOf;
    /// @notice All weekly winners ever, in chronological order (push order). The oracle reads
    ///         this off-chain to compute "weekly winners from quarter X" — no need to bucket
    ///         on-chain since the oracle already signs the entrant list.
    address[] internal _weeklyWinners;

    /// @notice Quarterly Filter Bowl entrants per (year, quarter). Recorded when the oracle
    ///         opens a quarterly competition. Year is the calendar year, quarter is 1-4.
    mapping(uint16 => mapping(uint8 => address[])) internal _quarterlyFinalists;
    /// @notice Per-period membership flag. Lets `recordQuarterlyChampion` confirm the named
    ///         champion was actually a finalist in *that* (year, quarter) — not just any
    ///         current QUARTERLY_FINALIST anywhere. Without this, a Q1 runner-up retaining
    ///         QUARTERLY_FINALIST status could be illegitimately crowned Q2 champion.
    mapping(uint16 => mapping(uint8 => mapping(address => bool))) public isQuarterlyFinalist;
    mapping(uint16 => mapping(uint8 => address)) public quarterlyChampionOf;

    /// @notice Annual Championship entrants per year. Recorded when the oracle opens an annual
    ///         competition. Must contain exactly 4 quarterly champions for that year.
    mapping(uint16 => address[]) internal _annualFinalists;
    /// @notice Per-year membership flag, mirroring `isQuarterlyFinalist`.
    mapping(uint16 => mapping(address => bool)) public isAnnualFinalist;
    mapping(uint16 => address) public annualChampionOf;

    // -------- Events
    event TokenFiltered(uint256 indexed seasonId, address indexed token);
    event WeeklyWinnerRecorded(uint256 indexed seasonId, address indexed winner);
    event QuarterlyFinalistsRecorded(uint16 indexed year, uint8 indexed quarter, address[] entrants);
    event QuarterlyChampionRecorded(uint16 indexed year, uint8 indexed quarter, address indexed champion);
    event AnnualFinalistsRecorded(uint16 indexed year, address[] entrants);
    event AnnualChampionRecorded(uint16 indexed year, address indexed champion);

    // -------- Errors
    error NotRegisteredVault();
    error NotOracle();
    error ZeroToken();
    error AlreadyFinalized();
    error NotEligible();
    error WrongQuarterCount();
    error EmptyEntrants();
    error AlreadyRecorded();
    /// @dev Quarter must be in [1, 4]. The status ladder is monotonic with no admin reset,
    ///      so a typo at the oracle (`quarter = 0` or `> 4`) would irreversibly bump tokens
    ///      to QUARTERLY_FINALIST / QUARTERLY_CHAMPION in slots `recordAnnualFinalists`
    ///      never reads — orphaning them with no path to the annual ladder.
    error BadQuarter();

    /// @dev Read the oracle from the launcher dynamically rather than caching at deploy
    ///      time. The launcher's oracle is rotatable via `setOracle`; if we cached here,
    ///      a rotated oracle could drive weekly settlement but not call our quarterly /
    ///      annual record functions, breaking the championship ladder mid-rotation.
    modifier onlyOracle() {
        if (msg.sender != ILauncherViewTR(launcher).oracle()) revert NotOracle();
        _;
    }

    function oracle() external view returns (address) {
        return ILauncherViewTR(launcher).oracle();
    }

    constructor(address launcher_) {
        launcher = launcher_;
    }

    // ============================================================ Weekly hooks (SeasonVault)

    /// @notice Called by the season's registered SeasonVault inside `submitWinner` to mark the
    ///         winner with WEEKLY_WINNER status (qualifying it for the next quarterly Filter
    ///         Bowl). Auth: msg.sender == launcher.vaultOf(seasonId).
    ///
    ///         Idempotent per season — reverts if already recorded so a misbehaving vault
    ///         can't double-credit.
    function recordWeeklyWinner(uint256 seasonId, address token) external {
        if (token == address(0)) revert ZeroToken();
        if (msg.sender != ILauncherViewTR(launcher).vaultOf(seasonId)) revert NotRegisteredVault();
        if (weeklyWinnerOf[seasonId] != address(0)) revert AlreadyRecorded();
        // FILTERED is terminal: a token that's been filtered cannot later be recorded as a
        // weekly winner. Without this, `_weeklyWinners` and `weeklyWinnerOf` would list a
        // token that `qualifiedFor(., QUARTERLY)` reports as ineligible (state inconsistent).
        // Practically unreachable today — fresh ERC-20s are deployed per season — but the
        // registry shouldn't trust upstream for the invariant.
        if (statusOf[token] == TokenStatus.FILTERED) revert NotEligible();

        weeklyWinnerOf[seasonId] = token;
        _weeklyWinners.push(token);
        // Don't downgrade tokens that already have a higher title (e.g. last quarter's
        // champion couldn't realistically re-enter as a token, but defend the invariant).
        if (statusOf[token] == TokenStatus.ACTIVE) {
            statusOf[token] = TokenStatus.WEEKLY_WINNER;
        }
        emit WeeklyWinnerRecorded(seasonId, token);
    }

    /// @notice Called by the season's registered SeasonVault inside `processFilterEvent` for
    ///         every loser. Marks status as FILTERED. Auth: msg.sender == launcher.vaultOf.
    ///
    ///         No-op if the token already has a non-ACTIVE status (e.g. a token that won a
    ///         prior week and was somehow re-launched — shouldn't happen, defensive only).
    function markFiltered(uint256 seasonId, address token) external {
        if (token == address(0)) revert ZeroToken();
        if (msg.sender != ILauncherViewTR(launcher).vaultOf(seasonId)) revert NotRegisteredVault();
        if (statusOf[token] != TokenStatus.ACTIVE) return;
        statusOf[token] = TokenStatus.FILTERED;
        emit TokenFiltered(seasonId, token);
    }

    // ============================================================ Quarterly hooks (oracle)

    /// @notice Oracle records the quarterly Filter Bowl entrant list. Each entrant must
    ///         currently be WEEKLY_WINNER (so quarterly finalists can only come from weekly
    ///         winners — the qualification ladder). Status is bumped to QUARTERLY_FINALIST.
    function recordQuarterlyFinalists(uint16 year, uint8 quarter, address[] calldata entrants)
        external
        onlyOracle
    {
        if (quarter == 0 || quarter > 4) revert BadQuarter();
        if (entrants.length == 0) revert EmptyEntrants();
        if (_quarterlyFinalists[year][quarter].length != 0) revert AlreadyRecorded();
        for (uint256 i = 0; i < entrants.length; ++i) {
            address t = entrants[i];
            if (t == address(0)) revert ZeroToken();
            if (statusOf[t] != TokenStatus.WEEKLY_WINNER) revert NotEligible();
            statusOf[t] = TokenStatus.QUARTERLY_FINALIST;
            _quarterlyFinalists[year][quarter].push(t);
            isQuarterlyFinalist[year][quarter][t] = true;
        }
        emit QuarterlyFinalistsRecorded(year, quarter, entrants);
    }

    /// @notice Records the quarterly champion. Must be a registered finalist for that
    ///         specific (year, quarter) — verified via `isQuarterlyFinalist`, not just by
    ///         global status. The membership flag is necessary because a Q1 runner-up retains
    ///         QUARTERLY_FINALIST status indefinitely; a status-only check would let it be
    ///         crowned champion of a different quarter where it never competed. Status bumps
    ///         to QUARTERLY_CHAMPION on success.
    ///
    ///         Auth: oracle OR the launcher's registered TournamentVault. The vault is the
    ///         on-chain caller during quarterly Filter Bowl settlement — it stamps the
    ///         champion atomically as part of `submitQuarterlyWinner`, so settlement and
    ///         status update can never drift apart. Oracle is retained as a fallback caller
    ///         (and pre-vault path before tournament infra is fully wired).
    function recordQuarterlyChampion(uint16 year, uint8 quarter, address champion) external {
        address senderOracle = ILauncherViewTR(launcher).oracle();
        address senderVault = ILauncherViewTR(launcher).tournamentVault();
        if (msg.sender != senderOracle && msg.sender != senderVault) revert NotOracle();
        if (quarter == 0 || quarter > 4) revert BadQuarter();
        if (champion == address(0)) revert ZeroToken();
        if (quarterlyChampionOf[year][quarter] != address(0)) revert AlreadyFinalized();
        if (!isQuarterlyFinalist[year][quarter][champion]) revert NotEligible();
        quarterlyChampionOf[year][quarter] = champion;
        statusOf[champion] = TokenStatus.QUARTERLY_CHAMPION;
        emit QuarterlyChampionRecorded(year, quarter, champion);
    }

    // ============================================================ Annual hooks (oracle)

    /// @notice Oracle opens the annual championship for `year`. The entrant list is the 4
    ///         registered quarterly champions of that year (`quarterlyChampionOf[year][1..4]`)
    ///         — the registry computes it itself, no entrant array passed. This makes
    ///         per-year validation automatic and removes the oracle's ability to enroll
    ///         a stray QUARTERLY_CHAMPION from a different year.
    ///
    ///         Reverts if any of the 4 quarters lacks a recorded champion, satisfying the
    ///         "annual requires four quarterly champions" constraint exactly.
    function recordAnnualFinalists(uint16 year) external onlyOracle {
        if (_annualFinalists[year].length != 0) revert AlreadyRecorded();
        address[] memory entrants = new address[](4);
        for (uint8 q = 1; q <= 4; ++q) {
            address t = quarterlyChampionOf[year][q];
            if (t == address(0)) revert WrongQuarterCount();
            entrants[q - 1] = t;
            statusOf[t] = TokenStatus.ANNUAL_FINALIST;
            _annualFinalists[year].push(t);
            isAnnualFinalist[year][t] = true;
        }
        emit AnnualFinalistsRecorded(year, entrants);
    }

    /// @notice Oracle records the annual champion. Must be a registered finalist for that
    ///         specific year — verified via `isAnnualFinalist`, not just by global status.
    ///         Same reasoning as the quarterly champion check.
    function recordAnnualChampion(uint16 year, address champion) external onlyOracle {
        if (champion == address(0)) revert ZeroToken();
        if (annualChampionOf[year] != address(0)) revert AlreadyFinalized();
        if (!isAnnualFinalist[year][champion]) revert NotEligible();
        annualChampionOf[year] = champion;
        statusOf[champion] = TokenStatus.ANNUAL_CHAMPION;
        emit AnnualChampionRecorded(year, champion);
    }

    // ============================================================ Views

    /// @notice All weekly winners ever recorded, in chronological order. Off-chain consumers
    ///         use this to compute "weekly winners in quarter X" and feed
    ///         `recordQuarterlyFinalists`.
    function getWeeklyWinners() external view returns (address[] memory) {
        return _weeklyWinners;
    }

    function weeklyWinnerCount() external view returns (uint256) {
        return _weeklyWinners.length;
    }

    /// @notice Quarterly Filter Bowl entrants for (year, quarter). Empty if not yet opened.
    function getQuarterlyFinalists(uint16 year, uint8 quarter) external view returns (address[] memory) {
        return _quarterlyFinalists[year][quarter];
    }

    /// @notice Annual Championship entrants for `year`. Empty if not yet opened.
    function getAnnualFinalists(uint16 year) external view returns (address[] memory) {
        return _annualFinalists[year];
    }

    /// @notice True iff `token` qualifies for `level`. Mirrors the qualification ladder:
    ///         ACTIVE → can compete at WEEKLY (always — weekly is open registration via the
    ///         launcher); WEEKLY_WINNER → qualifies for QUARTERLY; QUARTERLY_CHAMPION →
    ///         qualifies for ANNUAL.
    function qualifiedFor(address token, CompetitionLevel level) external view returns (bool) {
        TokenStatus s = statusOf[token];
        if (level == CompetitionLevel.WEEKLY) {
            // Weekly is open via the launcher; this contract's view is just "not filtered".
            return s == TokenStatus.ACTIVE;
        }
        if (level == CompetitionLevel.QUARTERLY) {
            return s == TokenStatus.WEEKLY_WINNER;
        }
        // ANNUAL
        return s == TokenStatus.QUARTERLY_CHAMPION;
    }
}
