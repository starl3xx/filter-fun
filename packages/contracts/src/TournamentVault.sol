// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITournamentRegistryView {
    function isQuarterlyFinalist(uint16 year, uint8 quarter, address token) external view returns (bool);
    function quarterlyChampionOf(uint16 year, uint8 quarter) external view returns (address);
    function recordQuarterlyChampion(uint16 year, uint8 quarter, address champion) external;
    function isAnnualFinalist(uint16 year, address token) external view returns (bool);
    function annualChampionOf(uint16 year) external view returns (address);
    function recordAnnualChampion(uint16 year, address champion) external;
}

interface ICreatorRegistryView {
    function creatorOf(address token) external view returns (address);
}

interface ILauncherViewTV {
    function oracle() external view returns (address);
}

/// @title TournamentVault
/// @notice Singleton escrow + settlement for the upper tiers of filter.fun's multi-timescale
///         championship ladder (Weekly → Quarterly Filter Bowl → Annual Championship). Hosts
///         per-(year, quarter) tournaments via the `*Quarterly` family and per-year annual
///         championships via the `*Annual` family — same struct, same 45/25/10/10/10 split,
///         same Merkle claim shape, distinguished only by the registry-side membership flag
///         (`isQuarterlyFinalist[year][quarter]` vs `isAnnualFinalist[year]`).
///
///         **Funding model — strictly tournament-controlled.** Per the user-aligned design,
///         "championship tournaments do not automatically destroy organic liquidity from
///         established tokens." The pot is funded by WETH push (`fundQuarterly`) — entry
///         stakes, fee shares forwarded by the protocol, and protocol-seeded prize pools.
///         There is **no `processFilterEvent` here**; weekly winners' organic LPs are never
///         unwound by this contract. Holders of losing weekly winners keep their tokens.
///
///         **Distribution at settlement — same 45/25/10/10/10 split as weekly.** When the
///         oracle posts the quarterly champion, the accumulated pot is split:
///
///           - 2.5% champion bounty: skimmed off-the-top, paid to the winner's creator.
///           - The remaining 97.5% is split per the standard four-way:
///             - 45% rollover (WETH; Merkle-claimable to holders of losing finalists)
///             - 25% bonus (WETH; Merkle-claimable after a hold delay — same 14d cadence
///               as weekly)
///             - 10% mechanics (WETH; immediate)
///             - 10% POL (WETH; **accumulated in this vault** — deployment to the winner's
///               pool via POLManager is wired in a follow-up PR. This contract just records
///               the accrual; the WETH stays parked here until the deployment path lands.)
///             - 10% treasury (WETH; immediate)
///
///         **Auth model.**
///         - `fundQuarterly` is permissionless — anyone can top up a tournament's pot.
///           In practice the oracle (or a fee-router) is the funder; making it open keeps
///           the door for community contribution / sponsorships without privilege.
///         - `submitQuarterlyWinner` is gated to the launcher's current oracle (read
///           dynamically via `launcher.oracle()` so the gate follows oracle rotations).
///         - The named winner must be in the registry's `isQuarterlyFinalist[year][quarter]`
///           membership map — set when the oracle called `recordQuarterlyFinalists` on the
///           registry. Per-period membership prevents a stray QUARTERLY_FINALIST (e.g. a
///           Q1 runner-up retaining its title) from being illegitimately crowned in Q2.
///
///         **Rollover semantics.** WETH-denominated for genesis. Holders of losing
///         quarterly finalists' tokens claim a Merkle-rooted (user, share) leaf and receive
///         a proportional cut of the rollover slice in WETH. They can swap to the
///         quarterly champion themselves if they want; the protocol does not auto-buy on
///         their behalf at the quarterly level. Auto-buy would require extending
///         `FilterLpLocker` auth so a TournamentVault can pull token-side liquidity from
///         a locker it didn't originally launch — left for a follow-up PR.
///
///         **Bonus semantics.** Same 14-day pattern as weekly: bonus is WETH-denominated,
///         locked behind `unlockTime`, paid out by Merkle proof. The oracle posts a single
///         bonus root at settlement (vs. multi-snapshot hold for weekly) — quarterly
///         eligibility is computed off-chain across the quarter's holdings, not via on-chain
///         multi-snapshot probing. Iteration target.
///
///         Each (year, quarter) tournament has its own self-contained `Tournament` struct,
///         keyed in storage and progressed through the phase machine independently.
contract TournamentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        Idle, // never funded; permissionless fund opens it
        Open, // accepting funds
        Settled, // winner submitted; rollover + bonus claims open (bonus may still be locked)
        Closed
    }

    // -------- Distribution BPS — must mirror SeasonVault exactly so the user-aligned split
    //          is identical across weekly + quarterly settlements.
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant BOUNTY_BPS = 250;
    uint256 public constant ROLLOVER_BPS = 4500;
    uint256 public constant BONUS_BPS = 2500;
    uint256 public constant MECHANICS_BPS = 1000;
    uint256 public constant POL_BPS = 1000;
    uint256 public constant TREASURY_BPS = 1000;

    // -------- Immutable wiring
    address public immutable launcher;
    address public immutable weth;
    address public immutable treasury;
    address public immutable mechanics;
    ITournamentRegistryView public immutable registry;
    ICreatorRegistryView public immutable creatorRegistry;
    /// @notice Bonus unlock delay relative to `submitQuarterlyWinner` block time. Mirrors
    ///         the weekly 14-day hold cadence so user expectations line up across timescales.
    uint256 public immutable bonusUnlockDelay;

    struct Tournament {
        Phase phase;
        // -------- Pot accounting
        uint256 funded; // total WETH ever deposited via fundQuarterly
        // -------- Settlement outputs
        address winner;
        address bountyCreator; // creator of the winner; address(0) ⇒ bounty redirected to treasury
        uint256 bountyAmount;
        uint256 rolloverReserve; // WETH set aside for rollover claims
        uint256 bonusReserve; // WETH set aside for bonus claims
        uint256 polAccumulated; // WETH parked for future POL deployment (no deployment path yet)
        bytes32 rolloverRoot;
        uint256 totalRolloverShares;
        uint256 claimedRolloverShares;
        bytes32 bonusRoot;
        uint256 totalBonusAmount;
        uint256 claimedBonusAmount;
        uint256 bonusUnlockTime;
    }

    mapping(uint16 => mapping(uint8 => Tournament)) internal _tournaments;
    /// @notice Per-(year, quarter, user) flags so users can't double-claim either reward.
    mapping(uint16 => mapping(uint8 => mapping(address => bool))) public rolloverClaimed;
    mapping(uint16 => mapping(uint8 => mapping(address => bool))) public bonusClaimed;

    /// @notice Per-year escrow for the **annual championship** — the top tier of the ladder.
    ///         Same `Tournament` struct shape as quarterly; same 45/25/10/10/10 split applied
    ///         at `submitAnnualWinner`. Validated via the registry's `isAnnualFinalist[year]`
    ///         membership flag — no quarter dimension since each year has one annual.
    mapping(uint16 => Tournament) internal _annualTournaments;
    mapping(uint16 => mapping(address => bool)) public annualRolloverClaimed;
    mapping(uint16 => mapping(address => bool)) public annualBonusClaimed;

    // -------- Events
    event TournamentFunded(uint16 indexed year, uint8 indexed quarter, address funder, uint256 amount);
    event QuarterlyWinnerSubmitted(
        uint16 indexed year,
        uint8 indexed quarter,
        address indexed winner,
        uint256 potConsumed,
        uint256 bountySlice,
        uint256 rolloverSlice,
        uint256 bonusSlice,
        uint256 mechanicsSlice,
        uint256 polSlice,
        uint256 treasurySlice
    );
    event ChampionBountyPaid(
        uint16 indexed year, uint8 indexed quarter, address indexed creator, uint256 amount
    );
    event ChampionBountyRedirected(uint16 indexed year, uint8 indexed quarter, uint256 amount);
    event RolloverClaimed(
        uint16 indexed year, uint8 indexed quarter, address indexed user, uint256 share, uint256 wethAmount
    );
    event BonusClaimed(uint16 indexed year, uint8 indexed quarter, address indexed user, uint256 amount);

    event AnnualTournamentFunded(uint16 indexed year, address funder, uint256 amount);
    event AnnualWinnerSubmitted(
        uint16 indexed year,
        address indexed winner,
        uint256 potConsumed,
        uint256 bountySlice,
        uint256 rolloverSlice,
        uint256 bonusSlice,
        uint256 mechanicsSlice,
        uint256 polSlice,
        uint256 treasurySlice
    );
    event AnnualChampionBountyPaid(uint16 indexed year, address indexed creator, uint256 amount);
    event AnnualChampionBountyRedirected(uint16 indexed year, uint256 amount);
    event AnnualRolloverClaimed(uint16 indexed year, address indexed user, uint256 share, uint256 wethAmount);
    event AnnualBonusClaimed(uint16 indexed year, address indexed user, uint256 amount);

    // -------- Errors
    error NotOracle();
    error WrongPhase();
    error BadQuarter();
    error ZeroAmount();
    error EmptyPot();
    error BadWinner();
    error WinnerNotFinalist();
    error AlreadySettled();
    error ZeroShares();
    error AlreadyClaimed();
    error InvalidProof();
    error BonusLocked();
    error ClaimExceedsAllocation();
    /// @dev Oracle-supplied `totalBonusAmount` exceeded the computed bonus slice. Without
    ///      this guard, an oracle bug (or compromised oracle) could publish a Merkle tree
    ///      summing to more WETH than the bonus reserve, and bonus claimants would drain
    ///      WETH earmarked for rollover / POL — both of which sit unsegregated in this
    ///      vault for the (year, quarter) tournament.
    error BonusExceedsReserve();

    modifier onlyOracle() {
        if (msg.sender != ILauncherViewTV(launcher).oracle()) revert NotOracle();
        _;
    }

    constructor(
        address launcher_,
        address weth_,
        address treasury_,
        address mechanics_,
        ITournamentRegistryView registry_,
        ICreatorRegistryView creatorRegistry_,
        uint256 bonusUnlockDelay_
    ) {
        launcher = launcher_;
        weth = weth_;
        treasury = treasury_;
        mechanics = mechanics_;
        registry = registry_;
        creatorRegistry = creatorRegistry_;
        bonusUnlockDelay = bonusUnlockDelay_;
    }

    // ============================================================ Funding

    /// @notice Permissionlessly top up the (year, quarter) tournament pot with WETH. Caller
    ///         must have approved this contract for `amount`. Quarter range is enforced
    ///         here (and at settlement) to match the registry's [1, 4] convention; without
    ///         it, an oracle typo at settlement could orphan the deposited WETH in a slot
    ///         the settlement function never reads.
    function fundQuarterly(uint16 year, uint8 quarter, uint256 amount) external nonReentrant {
        if (quarter == 0 || quarter > 4) revert BadQuarter();
        if (amount == 0) revert ZeroAmount();

        Tournament storage t = _tournaments[year][quarter];
        if (t.phase == Phase.Settled || t.phase == Phase.Closed) revert WrongPhase();

        IERC20(weth).safeTransferFrom(msg.sender, address(this), amount);
        t.funded += amount;
        // Idempotent: the first deposit moves Idle → Open; subsequent deposits leave it Open.
        if (t.phase == Phase.Idle) t.phase = Phase.Open;
        emit TournamentFunded(year, quarter, msg.sender, amount);
    }

    // ============================================================ Settlement

    /// @notice Oracle commits the quarterly champion. Validates membership, applies the
    ///         losers-pot split (2.5% bounty + 45/25/10/10/10), forwards mechanics +
    ///         treasury immediately, and locks the rollover + bonus reserves for Merkle
    ///         claims. The POL slice stays in this contract as WETH; deployment to the
    ///         winner's pool via POLManager is intentionally deferred to a follow-up PR
    ///         (requires extending the per-token locker's auth so a TournamentVault can
    ///         pull token-side liquidity from a locker it didn't originally launch).
    ///
    ///         Records `recordQuarterlyChampion` on the registry — that's what unlocks
    ///         the token's eligibility for the upcoming annual championship.
    function submitQuarterlyWinner(
        uint16 year,
        uint8 quarter,
        address winner_,
        bytes32 rolloverRoot_,
        uint256 totalRolloverShares_,
        bytes32 bonusRoot_,
        uint256 totalBonusAmount_
    ) external onlyOracle nonReentrant {
        if (quarter == 0 || quarter > 4) revert BadQuarter();
        if (winner_ == address(0)) revert BadWinner();
        if (totalRolloverShares_ == 0) revert ZeroShares();

        Tournament storage t = _tournaments[year][quarter];
        if (t.phase == Phase.Settled || t.phase == Phase.Closed) revert AlreadySettled();
        if (t.phase != Phase.Open || t.funded == 0) revert EmptyPot();

        // Per-period membership check via the registry. The registry's `isQuarterlyFinalist`
        // mapping is set when the oracle called `recordQuarterlyFinalists` for this exact
        // (year, quarter) — without it, a stale QUARTERLY_FINALIST status from a different
        // quarter could be crowned here.
        if (!registry.isQuarterlyFinalist(year, quarter, winner_)) revert WinnerNotFinalist();

        uint256 pot = t.funded;

        // Champion bounty off-the-top — same pattern as weekly SeasonVault.
        uint256 bounty = (pot * BOUNTY_BPS) / BPS_DENOMINATOR;
        uint256 remainder = pot - bounty;

        uint256 rollover = (remainder * ROLLOVER_BPS) / BPS_DENOMINATOR;
        uint256 bonus = (remainder * BONUS_BPS) / BPS_DENOMINATOR;
        uint256 mechanicsCut = (remainder * MECHANICS_BPS) / BPS_DENOMINATOR;
        uint256 pol = (remainder * POL_BPS) / BPS_DENOMINATOR;
        // Treasury absorbs rounding dust so the BPS arithmetic stays exact.
        uint256 treasuryCut = remainder - rollover - bonus - mechanicsCut - pol;

        // Oracle's published Merkle leaves must sum to ≤ the computed bonus slice.
        // Without this guard `claimQuarterlyBonus` (which caps via `totalBonusAmount`,
        // not `bonusReserve`) would let bonus claimants drain past the bonus slice into
        // rollover / POL escrow — both unsegregated in this vault. Equality is fine;
        // residual dust (if Merkle leaves sum to less than `bonus`) just stays here and
        // can be swept by a follow-up admin path.
        if (totalBonusAmount_ > bonus) revert BonusExceedsReserve();

        t.phase = Phase.Settled;
        t.winner = winner_;
        t.bountyAmount = bounty;
        t.rolloverReserve = rollover;
        t.bonusReserve = bonus;
        t.polAccumulated = pol;
        t.rolloverRoot = rolloverRoot_;
        t.totalRolloverShares = totalRolloverShares_;
        t.bonusRoot = bonusRoot_;
        t.totalBonusAmount = totalBonusAmount_;
        t.bonusUnlockTime = block.timestamp + bonusUnlockDelay;

        // Stamp QUARTERLY_CHAMPION on the registry — the gate to annual eligibility.
        registry.recordQuarterlyChampion(year, quarter, winner_);

        // Pay bounty → winner's creator (or redirect to treasury if no creator registered;
        // defensive — launch path always registers a creator).
        if (bounty > 0) {
            address creator = creatorRegistry.creatorOf(winner_);
            if (creator == address(0)) {
                IERC20(weth).safeTransfer(treasury, bounty);
                emit ChampionBountyRedirected(year, quarter, bounty);
            } else {
                t.bountyCreator = creator;
                IERC20(weth).safeTransfer(creator, bounty);
                emit ChampionBountyPaid(year, quarter, creator, bounty);
            }
        }

        if (mechanicsCut > 0) IERC20(weth).safeTransfer(mechanics, mechanicsCut);
        if (treasuryCut > 0) IERC20(weth).safeTransfer(treasury, treasuryCut);

        emit QuarterlyWinnerSubmitted(
            year, quarter, winner_, pot, bounty, rollover, bonus, mechanicsCut, pol, treasuryCut
        );
    }

    // ============================================================ Claims

    /// @notice Claim a rollover allocation. Merkle leaf is `keccak256(user, share)`; payout
    ///         is the proportional cut of `rolloverReserve` (in WETH). One claim per address
    ///         per (year, quarter).
    function claimQuarterlyRollover(uint16 year, uint8 quarter, uint256 share, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Tournament storage t = _tournaments[year][quarter];
        if (t.phase != Phase.Settled) revert WrongPhase();
        if (rolloverClaimed[year][quarter][msg.sender]) revert AlreadyClaimed();
        if (share == 0) revert ZeroShares();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, share));
        if (!MerkleProof.verifyCalldata(proof, t.rolloverRoot, leaf)) revert InvalidProof();

        uint256 amount = (share * t.rolloverReserve) / t.totalRolloverShares;
        rolloverClaimed[year][quarter][msg.sender] = true;
        t.claimedRolloverShares += share;
        if (t.claimedRolloverShares > t.totalRolloverShares) revert ClaimExceedsAllocation();

        IERC20(weth).safeTransfer(msg.sender, amount);
        emit RolloverClaimed(year, quarter, msg.sender, share, amount);
    }

    /// @notice Claim a bonus allocation. Merkle leaf is `keccak256(user, amount)`; payout is
    ///         exactly `amount` (in WETH). Unlocked at `bonusUnlockTime` (settlement +
    ///         `bonusUnlockDelay`). One claim per address per (year, quarter).
    function claimQuarterlyBonus(uint16 year, uint8 quarter, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Tournament storage t = _tournaments[year][quarter];
        if (t.phase != Phase.Settled) revert WrongPhase();
        if (block.timestamp < t.bonusUnlockTime) revert BonusLocked();
        if (bonusClaimed[year][quarter][msg.sender]) revert AlreadyClaimed();
        if (amount == 0) revert ZeroAmount();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProof.verifyCalldata(proof, t.bonusRoot, leaf)) revert InvalidProof();

        bonusClaimed[year][quarter][msg.sender] = true;
        t.claimedBonusAmount += amount;
        if (t.claimedBonusAmount > t.totalBonusAmount) revert ClaimExceedsAllocation();

        IERC20(weth).safeTransfer(msg.sender, amount);
        emit BonusClaimed(year, quarter, msg.sender, amount);
    }

    // ============================================================ Annual funding

    /// @notice Permissionlessly top up the annual championship pot for `year`. Same shape as
    ///         `fundQuarterly`: caller must have approved this contract for `amount`. The
    ///         annual layer has no quarter dimension; one tournament per year.
    function fundAnnual(uint16 year, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Tournament storage t = _annualTournaments[year];
        if (t.phase == Phase.Settled || t.phase == Phase.Closed) revert WrongPhase();

        IERC20(weth).safeTransferFrom(msg.sender, address(this), amount);
        t.funded += amount;
        if (t.phase == Phase.Idle) t.phase = Phase.Open;
        emit AnnualTournamentFunded(year, msg.sender, amount);
    }

    // ============================================================ Annual settlement

    /// @notice Oracle commits the annual champion. Validates membership against
    ///         `isAnnualFinalist[year]` (set by `recordAnnualFinalists` on the registry —
    ///         which reads the four `quarterlyChampionOf[year][1..4]` slots), applies the
    ///         losers-pot split (2.5% bounty + 45/25/10/10/10), forwards mechanics +
    ///         treasury immediately, and locks rollover + bonus reserves for Merkle claims.
    ///         POL slice stays in this vault as WETH (deployment deferred — same as
    ///         quarterly).
    ///
    ///         Records `recordAnnualChampion` on the registry — that's the terminal
    ///         status in the multi-timescale ladder (ANNUAL_CHAMPION).
    function submitAnnualWinner(
        uint16 year,
        address winner_,
        bytes32 rolloverRoot_,
        uint256 totalRolloverShares_,
        bytes32 bonusRoot_,
        uint256 totalBonusAmount_
    ) external onlyOracle nonReentrant {
        if (winner_ == address(0)) revert BadWinner();
        if (totalRolloverShares_ == 0) revert ZeroShares();

        Tournament storage t = _annualTournaments[year];
        if (t.phase == Phase.Settled || t.phase == Phase.Closed) revert AlreadySettled();
        if (t.phase != Phase.Open || t.funded == 0) revert EmptyPot();

        // Per-year membership check via the registry. Without the per-year flag, a
        // dangling ANNUAL_FINALIST status from a different year could be illegitimately
        // crowned here — the same shape of bug as the cross-period quarterly issue.
        if (!registry.isAnnualFinalist(year, winner_)) revert WinnerNotFinalist();

        uint256 pot = t.funded;
        uint256 bounty = (pot * BOUNTY_BPS) / BPS_DENOMINATOR;
        uint256 remainder = pot - bounty;

        uint256 rollover = (remainder * ROLLOVER_BPS) / BPS_DENOMINATOR;
        uint256 bonus = (remainder * BONUS_BPS) / BPS_DENOMINATOR;
        uint256 mechanicsCut = (remainder * MECHANICS_BPS) / BPS_DENOMINATOR;
        uint256 pol = (remainder * POL_BPS) / BPS_DENOMINATOR;
        uint256 treasuryCut = remainder - rollover - bonus - mechanicsCut - pol;

        // Same guard as quarterly: oracle-supplied bonus total cannot exceed the slice or
        // bonus claimants would drain rollover / POL escrow (all share this vault).
        if (totalBonusAmount_ > bonus) revert BonusExceedsReserve();

        t.phase = Phase.Settled;
        t.winner = winner_;
        t.bountyAmount = bounty;
        t.rolloverReserve = rollover;
        t.bonusReserve = bonus;
        t.polAccumulated = pol;
        t.rolloverRoot = rolloverRoot_;
        t.totalRolloverShares = totalRolloverShares_;
        t.bonusRoot = bonusRoot_;
        t.totalBonusAmount = totalBonusAmount_;
        t.bonusUnlockTime = block.timestamp + bonusUnlockDelay;

        registry.recordAnnualChampion(year, winner_);

        if (bounty > 0) {
            address creator = creatorRegistry.creatorOf(winner_);
            if (creator == address(0)) {
                IERC20(weth).safeTransfer(treasury, bounty);
                emit AnnualChampionBountyRedirected(year, bounty);
            } else {
                t.bountyCreator = creator;
                IERC20(weth).safeTransfer(creator, bounty);
                emit AnnualChampionBountyPaid(year, creator, bounty);
            }
        }

        if (mechanicsCut > 0) IERC20(weth).safeTransfer(mechanics, mechanicsCut);
        if (treasuryCut > 0) IERC20(weth).safeTransfer(treasury, treasuryCut);

        emit AnnualWinnerSubmitted(
            year, winner_, pot, bounty, rollover, bonus, mechanicsCut, pol, treasuryCut
        );
    }

    // ============================================================ Annual claims

    function claimAnnualRollover(uint16 year, uint256 share, bytes32[] calldata proof) external nonReentrant {
        Tournament storage t = _annualTournaments[year];
        if (t.phase != Phase.Settled) revert WrongPhase();
        if (annualRolloverClaimed[year][msg.sender]) revert AlreadyClaimed();
        if (share == 0) revert ZeroShares();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, share));
        if (!MerkleProof.verifyCalldata(proof, t.rolloverRoot, leaf)) revert InvalidProof();

        uint256 amount = (share * t.rolloverReserve) / t.totalRolloverShares;
        annualRolloverClaimed[year][msg.sender] = true;
        t.claimedRolloverShares += share;
        if (t.claimedRolloverShares > t.totalRolloverShares) revert ClaimExceedsAllocation();

        IERC20(weth).safeTransfer(msg.sender, amount);
        emit AnnualRolloverClaimed(year, msg.sender, share, amount);
    }

    function claimAnnualBonus(uint16 year, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Tournament storage t = _annualTournaments[year];
        if (t.phase != Phase.Settled) revert WrongPhase();
        if (block.timestamp < t.bonusUnlockTime) revert BonusLocked();
        if (annualBonusClaimed[year][msg.sender]) revert AlreadyClaimed();
        if (amount == 0) revert ZeroAmount();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProof.verifyCalldata(proof, t.bonusRoot, leaf)) revert InvalidProof();

        annualBonusClaimed[year][msg.sender] = true;
        t.claimedBonusAmount += amount;
        if (t.claimedBonusAmount > t.totalBonusAmount) revert ClaimExceedsAllocation();

        IERC20(weth).safeTransfer(msg.sender, amount);
        emit AnnualBonusClaimed(year, msg.sender, amount);
    }

    // ============================================================ Views

    function tournamentOf(uint16 year, uint8 quarter) external view returns (Tournament memory) {
        return _tournaments[year][quarter];
    }

    function annualTournamentOf(uint16 year) external view returns (Tournament memory) {
        return _annualTournaments[year];
    }

    /// @notice Live POL balance parked for `(year, quarter)`. Surfaces directly to the
    ///         indexer / UI so the broadcast can show the "champion-backing" number that
    ///         will be deployed once the POL deployment path lands.
    function pendingPolBalance(uint16 year, uint8 quarter) external view returns (uint256) {
        return _tournaments[year][quarter].polAccumulated;
    }

    function pendingAnnualPolBalance(uint16 year) external view returns (uint256) {
        return _annualTournaments[year].polAccumulated;
    }
}
