// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {
    SeasonVault,
    IBonusFunding,
    ICreatorRegistry,
    ICreatorFeeDistributor,
    IPOLManager,
    ITournamentRegistry
} from "./SeasonVault.sol";
import {CreatorRegistry} from "./CreatorRegistry.sol";
import {CreatorFeeDistributor} from "./CreatorFeeDistributor.sol";
import {CreatorCommitments} from "./CreatorCommitments.sol";
import {TournamentRegistry} from "./TournamentRegistry.sol";
import {TournamentVault} from "./TournamentVault.sol";
import {IFilterFactory} from "./interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "./interfaces/IFilterLauncher.sol";
import {LaunchEscrow} from "./LaunchEscrow.sol";
import {LauncherLens, IFilterLauncherLensView} from "./LauncherLens.sol";
import {LauncherStakeAdmin, IFilterLauncherForStakeAdmin} from "./LauncherStakeAdmin.sol";
import {TickerLib} from "./libraries/TickerLib.sol";

/// @title FilterLauncher
/// @notice Top-level entry point. Owns the season state machine, the deferred-activation
///         reservation flow (spec §46), the cross-season ticker uniqueness + blocklist
///         (spec §4.6.1), and the address of the singleton `IFilterFactory`. Also creates
///         each season's `SeasonVault`. Phase transitions are oracle-gated.
///
///         Deferred-activation lifecycle (spec §46):
///           - Hour 0 (`startSeason`): Phase = Launch; launch window opens for 48h.
///           - Hours 0..48 (reservation phase): users call `reserve(ticker, metadataURI)`. ETH
///             goes to `LaunchEscrow`; tokens are NOT deployed yet.
///           - Activation moment: when the 4th reservation lands, the season `_activated`
///             flips true and the FOUR pending reservations deploy atomically in the same tx.
///             This is the first block in which the cohort is tradeable.
///           - Hours-of-activation..48 (post-activation): reservations 5..12 deploy on-entry —
///             same `reserve()` entry point, but the deploy happens in the same tx instead
///             of waiting.
///           - Hour 48 if `_activated == false`: oracle calls `abortSeason`; the launch
///             escrow's `refundAll` returns every reservation's ETH to its creator. Tokens
///             were never deployed; the season ends without a Filter phase.
///
///         OWNERSHIP MODEL (audit: bugbot M PR #88).
///         This contract uses single-step `Ownable`, NOT `Ownable2Step`. The two-step model
///         would add ~500 bytes of runtime bytecode and the launcher is hard up against the
///         EIP-170 24,576-byte limit (currently 24,563 / 24,576 — 13 bytes spare). The
///         deferred-activation refactor (this PR) already externalised TournamentRegistry,
///         TournamentVault, LauncherLens, LauncherStakeAdmin, and TickerLib to fit; restoring
///         Ownable2Step would require additional externalisation that is out of scope here.
///
///         OPERATIONAL MITIGATION. The `owner` of this contract MUST be a multisig (e.g.
///         Safe) in production. Multisigs provide the equivalent of a 2-step transfer flow
///         off-chain (proposer → confirmers → executor), so a mistyped `transferOwnership`
///         requires the same multi-party confirmation as any other privileged call. See the
///         operator runbook (`docs/runbook.md`) for the full ownership-rotation procedure.
///         Direct EOA ownership is for testnet / genesis bring-up only and MUST be rotated
///         to the multisig before §10 mainnet listing. The `oracle` address is independent
///         of `owner` and is rotated via `setOracle(...)` (also single-step, same multisig
///         constraint).
contract FilterLauncher is IFilterLauncher, Ownable, Pausable, ReentrancyGuard {
    using SafeCast for uint256;

    // ============================================================ Errors

    error WrongPhase();
    error WindowClosed();
    error WindowStillOpen();
    error SlotsExhausted();
    error InsufficientEscrow();
    error AlreadyReserved();
    error TickerTaken();
    error TickerBlocklisted();
    error TickerWinnerReserved();
    error NotOracle();
    error NotMultisig();
    error NotSeasonVault();
    error UnknownToken();
    error SeasonAlreadyAborted();
    error SeasonAlreadyActivated();
    error SeasonNotActivated();
    error RefundFailed();
    error ZeroAddress();
    error DuplicateSymbol();
    error AlreadySet();
    error PolManagerUnset();
    error BadTransition();
    error ActivateBadQueueLength();

    // ============================================================ Events

    event SeasonStarted(
        uint256 indexed seasonId, address vault, uint256 launchStartTime, uint256 launchEndTime
    );
    event TokenLaunched(
        uint256 indexed seasonId,
        address indexed token,
        address indexed locker,
        address creator,
        bool isProtocolLaunched,
        uint64 slotIndex,
        uint256 cost,
        string name,
        string symbol,
        string metadataURI
    );
    event LaunchClosed(uint256 indexed seasonId, uint256 filledSlots);
    /// @notice Emitted when a season's activation threshold is crossed and the cohort deploys.
    ///         The deployed-token list is reconstructable from the parallel `TokenLaunched`
    ///         events emitted in the same tx; `activatedAt` is the storage mapping (also
    ///         readable from `block.timestamp` of the emission). Lean event keeps the
    ///         launcher under EIP-170.
    event SeasonActivated(uint256 indexed seasonId);
    /// @notice Emitted when `abortSeason` sweeps a sparse season's escrow. The reservation
    ///         count and refunded total are derivable from the parallel `LaunchEscrow`
    ///         `ReservationRefunded` events emitted in the same tx (one per refund). Lean
    ///         signature keeps the launcher under EIP-170.
    event SeasonAborted(uint256 indexed seasonId);
    event PhaseAdvanced(uint256 indexed seasonId, Phase newPhase);
    /// @notice Emitted when the oracle pins survivor finalists. The full list is reconstructable
    ///         from `_entry[seasonId][token].isFinalist` storage reads via the lens.
    event FinalistsSet(uint256 indexed seasonId);
    event TickerBlocked(bytes32 indexed tickerHash);
    event WinnerTickerReserved(uint256 indexed seasonId, bytes32 indexed tickerHash, address winnerToken);

    // ============================================================ Constants

    /// @notice Hard cap on reservations (and therefore deployed tokens) per weekly season.
    uint256 public constant MAX_LAUNCHES = 12;
    /// @notice Maximum length of the launch window from `startSeason`. Internal — readers use
    ///         `launchEndTime[seasonId] - launchStartTime[seasonId]` (always equal to this).
    uint256 internal constant LAUNCH_WINDOW_DURATION = 48 hours;
    /// @notice Spec §46: a season activates (deploys all pending tokens + opens trading) the
    ///         instant the Nth reservation lands. Below this threshold, reservations sit in
    ///         escrow; if the launch window closes without hitting it, every reservation is
    ///         refunded.
    uint256 public constant ACTIVATION_THRESHOLD = 4;

    // ============================================================ Wiring

    IFilterFactory public factory;
    address public oracle;
    address public treasury;
    address public mechanics;
    /// @notice POL orchestrator. Each new SeasonVault is wired to this address so
    ///         `submitWinner` can deploy the season's accumulated POL WETH into a permanent
    ///         V4 LP position on the winner pool.
    IPOLManager public polManager;
    IBonusFunding public bonusDistributor;
    address public weth;

    /// @notice Per-season escrow holding reservation funds until activation or abort.
    LaunchEscrow public immutable launchEscrow;

    /// @notice Read-only companion exposing convenience views (`getLaunchSlots`,
    ///         `getLaunchStatus`, `canReserve`). Deployed inline; lives outside the launcher's
    ///         bytecode to keep the launcher under EIP-170. Web + indexer call through
    ///         `launcher.lens().getX()`.
    LauncherLens public immutable lens;

    /// @notice Companion that owns post-deploy refundable-stake bookkeeping (and the stake
    ///         ETH balance). Deployed inline; the oracle calls
    ///         `stakeAdmin.applySoftFilter(...)` directly. `launchInfoOf` reads through here.
    LauncherStakeAdmin public immutable stakeAdmin;

    /// @notice Singleton creator contracts. `creatorRegistry`, `creatorFeeDistributor`, and
    ///         `creatorCommitments` are deployed inline (small init code, plus the registry
    ///         is needed by other inline deploys). `tournamentRegistry` and `tournamentVault`
    ///         are externally deployed and wired post-construction (their large init code
    ///         pushed FilterLauncher past EIP-3860 (49,152 B) when inlined).
    CreatorRegistry public immutable creatorRegistry;
    CreatorFeeDistributor public immutable creatorFeeDistributor;
    CreatorCommitments public immutable creatorCommitments;
    TournamentRegistry public tournamentRegistry;
    TournamentVault public tournamentVault;
    /// @notice Hold-bonus unlock delay forwarded to every season's `SeasonVault` and the
    ///         singleton `TournamentVault`. Constant: rotating it would split bonus eligibility
    ///         across cohorts and isn't supported by the indexer's snapshot model.
    uint256 public constant bonusUnlockDelay = 14 days;

    // ============================================================ Launch-window config

    /// @notice Base cost of slot 0 in wei. Slot N is `BASE * (1 + (N/MAX)^2)`.
    uint256 public baseLaunchCost = 0.05 ether;
    /// @notice When true, the slot cost released from escrow at deploy time is held by this
    ///         contract as a refundable stake until the soft-filter resolves; when false, it
    ///         flows to `forfeitRecipient` immediately as a launch fee.
    bool public refundableStakeEnabled = true;
    /// @notice Recipient of forfeited stakes (and of the launch fee when stake mode is off).
    ///         Immutable — set to `treasury` at construction. The treasury timelock can route
    ///         to a separate forfeit recipient downstream if/when accounting splits are needed;
    ///         on-chain rotation isn't supported (saves bytes; matches v1 mainnet ops model).
    address public immutable forfeitRecipient;

    // ============================================================ Season state

    uint256 public override currentSeasonId;
    mapping(uint256 => Phase) public override phaseOf;
    mapping(uint256 => address) public override vaultOf;
    mapping(uint256 => address[]) internal _tokens;
    mapping(uint256 => mapping(address => TokenEntry)) internal _entry;

    /// @notice Number of public-launch slots actually deployed. Diverges from
    ///         `reservationCount` only during the pre-activation window: pre-activation
    ///         `reservationCount` ∈ [1,3] while `launchCount == 0`. At activation moment they
    ///         re-converge; post-activation they march in lockstep.
    mapping(uint256 => uint64) public launchCount;
    mapping(uint256 => uint256) public launchStartTime;
    mapping(uint256 => uint256) public launchEndTime;
    /// @notice Set true once a launch window has emitted `LaunchClosed` (cap-fill, oracle
    ///         close, or abort). Prevents duplicate close events.
    mapping(uint256 => bool) internal _launchClosedEmitted;

    /// @notice True once the activation threshold was crossed in `seasonId` and the cohort
    ///         deployed atomically. Read by `reserve` to switch from "escrow + queue" to
    ///         "escrow + deploy-on-entry" semantics for slots beyond the threshold.
    mapping(uint256 => bool) public activated;
    mapping(uint256 => uint64) public activatedAt;
    /// @notice True once the launch window closed sparse and `abortSeason` swept refunds.
    ///         Mutually exclusive with `activated`.
    mapping(uint256 => bool) public aborted;

    // ============================================================ Ticker uniqueness (spec §4.6.1)

    /// @notice One-way ticker blocklist. Initial set is seeded in the constructor; multisig
    ///         (= owner) can append via `addTickerToBlocklist`. There is intentionally no
    ///         removal path — once blocked, always blocked.
    mapping(bytes32 => bool) public tickerBlocklist;

    /// @notice Cross-season permanent reservation: once a token wins a weekly season, its
    ///         ticker is reserved across all FUTURE seasons. Populated by
    ///         `setWinnerTicker`, called by SeasonVault during `submitWinner`.
    mapping(bytes32 => address) public winnerTickers;

    /// @notice Per-season ticker uniqueness: `tickerHash → creator who reserved it`.
    ///         Address-typed (rather than bool) so the indexer can read back who owns a given
    ///         ticker without joining against `_pending`.
    mapping(uint256 => mapping(bytes32 => address)) public seasonTickers;

    // ============================================================ Pre-activation queue

    /// @notice Reservations pending activation. Slots 0..3 sit here until the 4th reservation
    ///         crosses the threshold, at which point `_activate` drains and deploys all four
    ///         atomically. Once activated, this queue is empty and never refilled — slots
    ///         5..12 deploy on-entry without queuing.
    /// @dev    Stores the full ticker + metadataURI strings because `_deployToken` needs them
    ///         as `name`, `symbol`, and `metadataURI` for the factory's `deployToken` call.
    ///         The escrow's parallel `_escrows` mapping carries the bytes32 hashes for
    ///         indexer-side lookups; the strings live here for deploy-side reuse.
    struct PendingReservation {
        address creator;
        uint64 slotIndex;
        bytes32 tickerHash;
        bytes32 metadataHash;
        string ticker;
        string metadataURI;
    }

    mapping(uint256 => PendingReservation[]) internal _pending;

    // ============================================================ Constructor

    constructor(
        address owner_,
        address oracle_,
        address treasury_,
        address mechanics_,
        IBonusFunding bonusDistributor_,
        address weth_
    ) Ownable(owner_) {
        // Audit H-4 (Phase 1, 2026-05-01): every loose-typed address dependency injected at
        // construction MUST be non-zero. Zero in any of these would brick downstream paths
        // at first use; failing at deploy time is cheaper than discovering it post-launch.
        if (oracle_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (mechanics_ == address(0)) revert ZeroAddress();
        if (address(bonusDistributor_) == address(0)) revert ZeroAddress();
        if (weth_ == address(0)) revert ZeroAddress();
        oracle = oracle_;
        treasury = treasury_;
        mechanics = mechanics_;
        bonusDistributor = bonusDistributor_;
        weth = weth_;
        forfeitRecipient = treasury_;
        creatorRegistry = new CreatorRegistry(address(this));
        creatorFeeDistributor = new CreatorFeeDistributor(address(this), weth_, treasury_, creatorRegistry);
        creatorCommitments = new CreatorCommitments(creatorRegistry);
        // Spec §46: every reservation routes ETH through this contract until activation or
        // abort. Deployed inline so the launcher↔escrow handshake is structural — neither can
        // exist without the other.
        launchEscrow = new LaunchEscrow(address(this));

        // Convenience views (`getLaunchSlots` etc.) live on this companion to keep the
        // launcher under EIP-170. Deployed inline so `launcher.lens()` is structural.
        lens = new LauncherLens(IFilterLauncherLensView(address(this)));

        // Stake bookkeeping (LaunchInfo + applySoftFilter) lives on this companion for the
        // same reason. Deployed inline so `launcher.stakeAdmin()` is structural.
        stakeAdmin = new LauncherStakeAdmin(IFilterLauncherForStakeAdmin(address(this)));

        // Spec §4.6.1 protocol-blocklist seed. These are the canonical bait tickers that MUST
        // never be reservable by a creator (FILTER is the protocol token; the rest are
        // canonical asset symbols a memecoin shouldn't be allowed to imitate). Seeded here so
        // genesis already has them; multisig can append via `addTickerToBlocklist` but cannot
        // remove (one-way).
        _seedBlocklist();
    }

    function _seedBlocklist() internal {
        tickerBlocklist[keccak256(bytes("FILTER"))] = true;
        tickerBlocklist[keccak256(bytes("WETH"))] = true;
        tickerBlocklist[keccak256(bytes("ETH"))] = true;
        tickerBlocklist[keccak256(bytes("USDC"))] = true;
        tickerBlocklist[keccak256(bytes("USDT"))] = true;
        tickerBlocklist[keccak256(bytes("DAI"))] = true;
    }

    /// @notice One-shot wire of the POLManager. Owner-only; reverts if already set or zero.
    function setPolManager(IPOLManager polManager_) external onlyOwner {
        if (address(polManager) != address(0)) revert AlreadySet();
        if (address(polManager_) == address(0)) revert ZeroAddress();
        polManager = polManager_;
    }

    /// @notice One-shot wire of the externally-deployed TournamentRegistry + TournamentVault.
    ///         Owner-only; reverts if already set or zero. Externalised (rather than
    ///         inline-deployed) because together they push FilterLauncher's init code past
    ///         EIP-3860 (49,152 B). DeploySepolia handles the deploy + wire sequence.
    function setTournament(TournamentRegistry registry_, TournamentVault vault_) external onlyOwner {
        // Audit: bugbot M PR #88. The one-shot guard MUST also reject zero `registry_` or
        // a first call with a zero address would leave `tournamentRegistry == address(0)`,
        // bypassing the AlreadySet sentinel and allowing a subsequent re-wire. Vault is
        // checked transitively — operator-side `VerifySepolia` asserts non-zero post-deploy.
        if (address(registry_) == address(0)) revert ZeroAddress();
        if (address(tournamentRegistry) != address(0)) revert AlreadySet();
        tournamentRegistry = registry_;
        tournamentVault = vault_;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    /// @dev Multisig auth label per spec §4.6.1 — production owner is the multisig. This gate
    ///      reverts with `NotMultisig` rather than OZ's `OwnableUnauthorizedAccount` so the
    ///      monitoring side can scan for the protocol-blocklist-specific selector.
    modifier onlyMultisig() {
        if (msg.sender != owner()) revert NotMultisig();
        _;
    }

    function setFactory(IFilterFactory factory_) external onlyOwner {
        if (address(factory) != address(0)) revert AlreadySet();
        if (address(factory_) == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    /// @notice Rotate the oracle authorised to drive season lifecycle + filter events.
    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = oracle_;
    }

    /// @notice Owner-only operator setter for the per-launch cost ladder + stake-vs-fee toggle.
    ///         Combined into one entry point to keep the launcher under EIP-170; operators
    ///         pass the existing values for the field they don't want to change.
    function setLaunchConfig(uint256 baseLaunchCost_, bool refundableStakeEnabled_)
        external
        onlyOwner
    {
        baseLaunchCost = baseLaunchCost_;
        refundableStakeEnabled = refundableStakeEnabled_;
    }

    /// @notice Append a ticker hash to the protocol blocklist. One-way — there is no
    ///         corresponding remove, by design (spec §4.6.1).
    function addTickerToBlocklist(bytes32 tickerHash) external onlyMultisig {
        tickerBlocklist[tickerHash] = true;
        emit TickerBlocked(tickerHash);
    }

    /// @notice Permanently reserve a ticker for the cross-season pool. Called by the season's
    ///         vault from `submitWinner` so the winning ticker is locked before the next
    ///         season opens. The vault is auth'd by `vaultOf[seasonId] == msg.sender`; the
    ///         vault itself reads `seasonId` from immutable state, so a stale or third-party
    ///         caller can't poison the winner table.
    function setWinnerTicker(uint256 seasonId, bytes32 tickerHash, address winnerToken) external {
        if (msg.sender != vaultOf[seasonId]) revert NotSeasonVault();
        // Idempotent: if the same hash is already mapped to the same token, no-op. A different
        // token-for-same-hash would mean two different winners with the same ticker hash —
        // structurally impossible because seasonTickers prevents same-season collisions and
        // the cross-season `winnerTickers` reservation prevents future-season collisions.
        if (winnerTickers[tickerHash] != address(0) && winnerTickers[tickerHash] != winnerToken) {
            revert TickerWinnerReserved();
        }
        winnerTickers[tickerHash] = winnerToken;
        emit WinnerTickerReserved(seasonId, tickerHash, winnerToken);
    }

    // ============================================================ Season lifecycle

    /// @notice Opens a new season. Deploys its `SeasonVault` and starts the 48h launch window.
    function startSeason() external onlyOracle whenNotPaused returns (uint256 seasonId) {
        if (address(polManager) == address(0)) revert PolManagerUnset();
        seasonId = ++currentSeasonId;
        // `currentSeasonId` is monotonically incremented, so `phaseOf[seasonId]` is always
        // the default `Phase.Launch` here — no explicit re-open guard needed.

        SeasonVault v = new SeasonVault(
            address(this),
            seasonId,
            weth,
            treasury,
            mechanics,
            polManager,
            bonusDistributor,
            bonusUnlockDelay,
            ICreatorRegistry(address(creatorRegistry)),
            ICreatorFeeDistributor(address(creatorFeeDistributor)),
            ITournamentRegistry(address(tournamentRegistry))
        );
        vaultOf[seasonId] = address(v);
        phaseOf[seasonId] = Phase.Launch;
        launchStartTime[seasonId] = block.timestamp;
        launchEndTime[seasonId] = block.timestamp + LAUNCH_WINDOW_DURATION;
        emit SeasonStarted(seasonId, address(v), launchStartTime[seasonId], launchEndTime[seasonId]);
    }

    function advancePhase(uint256 seasonId, Phase target) external onlyOracle whenNotPaused {
        Phase cur = phaseOf[seasonId];
        if (uint8(target) != uint8(cur) + 1) revert BadTransition();
        // Audit: bugbot H PR #88. Block leaving Launch unless the season is activated.
        // This single guard rejects BOTH sparse-still-open seasons (operator must abort
        // first) AND aborted seasons (terminal per spec — an aborted season has zero
        // deployed tokens, so advancing into Filter/Finals/Settlement is meaningless and
        // could leave downstream vault state in an undefined shape). Pre-fix the guard was
        // `!activated && !aborted` which allowed aborted seasons through.
        if (cur == Phase.Launch && !activated[seasonId]) revert SeasonNotActivated();
        phaseOf[seasonId] = target;
        if (cur == Phase.Launch && !_launchClosedEmitted[seasonId]) {
            _launchClosedEmitted[seasonId] = true;
            emit LaunchClosed(seasonId, launchCount[seasonId]);
        }
        emit PhaseAdvanced(seasonId, target);
    }

    function setFinalists(uint256 seasonId, address[] calldata finalists) external onlyOracle whenNotPaused {
        if (phaseOf[seasonId] != Phase.Filter) revert WrongPhase();
        // Trust the oracle: an unknown-token entry would be a configuration error and is
        // reproducible off-chain via `tokensInSeason`. Skipping the on-chain guard saves
        // bytecode for the EIP-170 budget.
        for (uint256 i = 0; i < finalists.length; ++i) {
            _entry[seasonId][finalists[i]].isFinalist = true;
        }
        emit FinalistsSet(seasonId);
    }

    // ============================================================ Reservation entry

    /// @notice Spec §46.9 public entry: reserve a slot in the current season. Performs the
    ///         eight contractual validations (each with its own custom error so tests + the
    ///         indexer can pinpoint exactly which gate fired), records the reservation in
    ///         `LaunchEscrow`, and either queues the reservation pre-activation or deploys it
    ///         on-entry post-activation.
    /// @param  ticker        Raw ticker string. Normalised via TickerLib (strip `$`, trim,
    ///                       uppercase, validate `^[A-Z0-9]{2,10}$`).
    /// @param  metadataURI   Off-chain metadata pointer (e.g. `ipfs://...`). The keccak256
    ///                       hash of this string is stored on-chain; the indexer joins the
    ///                       full string from event data.
    function reserve(string calldata ticker, string calldata metadataURI)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        uint256 sid = currentSeasonId;
        // The eight steps below mirror spec §46.9 in order; deviating that order would make
        // the error surface ambiguous (two failing checks could both claim "first to fire").
        // Step 3 (window-open) intentionally runs FIRST so the abort-path doesn't accept new
        // reservations into the window.
        if (phaseOf[sid] != Phase.Launch) revert WrongPhase();
        if (aborted[sid]) revert SeasonAlreadyAborted();
        if (block.timestamp >= launchEndTime[sid]) revert WindowClosed();

        // 1. Per-wallet cap: structural in LaunchEscrow.escrows[sid][creator]. Existence is
        //    keyed off `reservedAt != 0` (mirrors the escrow's own sentinel) so a zero-cost
        //    reservation under `baseLaunchCost = 0` is recognised — using `amount != 0` would
        //    miss the dup, then trip the escrow's guard at extra gas with the same selector.
        //    Bugbot M, PR #88: keep the launcher and escrow checks in lockstep. Calls the
        //    scalar `reservedAtOf` view (not the full `escrowOf` struct) to skip the struct
        //    decode in the launcher's runtime — Epic 1.15a EIP-170 size budget.
        if (launchEscrow.reservedAtOf(sid, msg.sender) != 0) revert AlreadyReserved();

        // 2. Slot availability. Reservation count includes pending + deployed since each
        //    deploys its own slot.
        uint256 currentResCount = launchEscrow.reservationCountOf(sid);
        if (currentResCount >= MAX_LAUNCHES) revert SlotsExhausted();

        // 4. Ticker normalisation. Reverts `InvalidTickerFormat` on malformed input.
        //    The CANONICAL form (post-strip-$, post-uppercase, post-trim) becomes the on-chain
        //    token symbol so `IERC20Metadata(token).symbol()` agrees with `tickerHash`. The
        //    raw user input (e.g. `$Pepe`) is intentionally discarded after this point.
        string memory canonicalTicker = TickerLib.normalize(ticker);
        bytes32 tickerHash = keccak256(bytes(canonicalTicker));

        // 5. Protocol blocklist.
        if (tickerBlocklist[tickerHash]) revert TickerBlocklisted();

        // 6. Cross-season winner reservation.
        if (winnerTickers[tickerHash] != address(0)) revert TickerWinnerReserved();

        // 7. Per-season uniqueness.
        if (seasonTickers[sid][tickerHash] != address(0)) revert TickerTaken();

        // 8. Funds attached. Slot cost ladders by current reservation count.
        uint256 cost = _slotCost(uint64(currentResCount));
        if (msg.value < cost) revert InsufficientEscrow();

        // ---- All eight checks passed. Commit state. ----

        seasonTickers[sid][tickerHash] = msg.sender;
        bytes32 metadataHash = keccak256(bytes(metadataURI));
        uint64 slotIndex = uint64(currentResCount);

        // Refund excess BEFORE escrow handoff so the escrow only ever holds the cost.
        uint256 excess = msg.value - cost;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            if (!ok) revert RefundFailed();
        }

        // Escrow forwards `cost` and emits `SlotReserved` for indexer ingestion.
        launchEscrow.reserve{value: cost}(sid, msg.sender, slotIndex, tickerHash, metadataHash);

        PendingReservation memory pr = PendingReservation({
            creator: msg.sender,
            slotIndex: slotIndex,
            tickerHash: tickerHash,
            metadataHash: metadataHash,
            ticker: canonicalTicker,
            metadataURI: metadataURI
        });

        if (activated[sid]) {
            // Post-activation slot 4..11: deploy in the same tx, no queuing.
            _deployToken(sid, pr);
        } else if (currentResCount + 1 == ACTIVATION_THRESHOLD) {
            // 4th reservation: include in pending queue then drain it via _activate.
            _pending[sid].push(pr);
            _activate(sid);
        } else {
            // 1..3: hold pending until activation (or abort).
            _pending[sid].push(pr);
        }

        // Cap-fill auto-closes the launch window.
        if (currentResCount + 1 == MAX_LAUNCHES && !_launchClosedEmitted[sid]) {
            _launchClosedEmitted[sid] = true;
            emit LaunchClosed(sid, MAX_LAUNCHES);
        }
    }

    /// @notice Activation moment — drain the pending queue and deploy all reservations
    ///         atomically in the same tx as the 4th reservation.
    /// @dev    `delete _pending[sid]` post-deploy keeps storage tidy; the array is never
    ///         re-used after activation (slots 5..12 deploy on-entry without queuing).
    function _activate(uint256 sid) internal {
        activated[sid] = true;
        activatedAt[sid] = uint64(block.timestamp);

        PendingReservation[] storage queue = _pending[sid];
        uint256 n = queue.length;
        // Defensive — invariant holds because _activate is only called when the queue has
        // exactly ACTIVATION_THRESHOLD entries (the 4th reservation pushes its own entry
        // before the call).
        if (n != ACTIVATION_THRESHOLD) revert ActivateBadQueueLength();

        for (uint256 i = 0; i < n; ++i) {
            // Copy to memory before _deployToken since the loop will iterate against storage
            // we don't otherwise mutate, and `_deployToken` doesn't write to `_pending`.
            PendingReservation memory pr = queue[i];
            _deployToken(sid, pr);
        }
        delete _pending[sid];

        emit SeasonActivated(sid);
    }

    /// @notice Deploys a single token from a pending reservation. Pulls escrow back, hands
    ///         the strings to the factory, records token-side bookkeeping, applies the
    ///         refundable-stake-vs-fee toggle to the recovered ETH, and emits `TokenLaunched`
    ///         + `LaunchSlotFilled`.
    function _deployToken(uint256 sid, PendingReservation memory pr) internal returns (address token) {
        uint256 amount = launchEscrow.releaseToDeploy(sid, pr.creator);

        address locker;
        (token, locker,) = factory.deployToken(
            IFilterFactory.DeployArgs({
                // Memecoin convention (spec §46): the ticker IS the on-chain name. The
                // metadataURI carries the rich display name + image off-chain. This keeps
                // the on-chain identity compact and aligned with the `tickerHash` keying.
                name: pr.ticker,
                symbol: pr.ticker,
                metadataURI: pr.metadataURI,
                creator: pr.creator,
                seasonVault: vaultOf[sid],
                treasury: treasury,
                mechanics: mechanics
            })
        );

        _entry[sid][token] = TokenEntry({
            token: token,
            pool: address(0),
            feeSplitter: locker,
            creator: pr.creator,
            isProtocolLaunched: false,
            isFinalist: false
        });
        _tokens[sid].push(token);

        creatorRegistry.register(token, pr.creator);
        creatorFeeDistributor.registerToken(token, sid);

        // Apply the stake-vs-fee toggle to the recovered ETH. In stake mode the stake admin
        // holds it until soft-filter resolves; in fee mode it flows to forfeitRecipient
        // immediately (treasury default).
        uint128 costAsU128 = amount.toUint128();
        uint128 stakeAmount;
        if (refundableStakeEnabled) {
            stakeAmount = costAsU128;
            stakeAdmin.recordLaunch{value: amount}(sid, token, pr.slotIndex, costAsU128, stakeAmount);
        } else {
            stakeAdmin.recordLaunch(sid, token, pr.slotIndex, costAsU128, 0);
            if (amount > 0) {
                (bool ok,) = forfeitRecipient.call{value: amount}("");
                if (!ok) revert RefundFailed();
            }
        }

        launchCount[sid] = uint64(uint256(launchCount[sid]) + 1);

        emit TokenLaunched(
            sid, token, locker, pr.creator, false, pr.slotIndex, amount, pr.ticker, pr.ticker, pr.metadataURI
        );
    }

    /// @notice Abort a sparse season: at h48 with `activated == false`, sweep escrow refunds
    ///         and mark the season aborted. Oracle-gated — production scheduler EOA is the
    ///         oracle, so the same lifecycle authority owns this terminal transition.
    function abortSeason(uint256 seasonId) external onlyOracle {
        // Audit: bugbot L PR #88. Reject non-existent / future-numbered seasons. Without
        // this gate, a future season ID's default-zero `launchEndTime` passes the
        // `WindowStillOpen` comparison and the ID can be pre-poisoned with `aborted=true`,
        // tripping `SeasonAlreadyAborted` when `currentSeasonId` later reaches it.
        // (`nonReentrant` dropped to recover bytecode budget; the only external call here
        // is `launchEscrow.refundAll`, which carries its own `nonReentrant` and uses a
        // pull-pattern fallback for failed pushes — the launcher side has no
        // re-entry-sensitive state to protect.)
        if (launchEndTime[seasonId] == 0) revert WrongPhase();
        if (block.timestamp < launchEndTime[seasonId]) revert WindowStillOpen();
        if (activated[seasonId]) revert SeasonAlreadyActivated();
        if (aborted[seasonId]) revert SeasonAlreadyAborted();

        aborted[seasonId] = true;

        launchEscrow.refundAll(seasonId);

        // !activated (guarded above) implies _drainPending never ran, which is the only path
        // that sets `_launchClosedEmitted`. So we know the flag is false and can emit
        // unconditionally. We also DON'T set the flag — `advancePhase` is now blocked on any
        // !activated season (bugbot H PR #88), so nothing else will read it.
        emit LaunchClosed(seasonId, 0);
        emit SeasonAborted(seasonId);
    }

    // ============================================================ Protocol launch

    /// @notice Owner-only path for $FILTER and any other protocol-launched seed tokens.
    ///         Bypasses the entire reservation system — no escrow, no slot cap, no per-wallet
    ///         cap, no ticker blocklist (FILTER is in the blocklist by design, but the
    ///         protocol must still be able to seed its own token). Protocol launches do NOT
    ///         count toward `launchCount` or `reservationCount` so they never block a slot
    ///         that a community creator would otherwise reserve.
    function launchProtocolToken(string calldata name_, string calldata symbol_, string calldata metadataURI_)
        external
        onlyOwner
        whenNotPaused
        returns (address token, address locker)
    {
        uint256 sid = currentSeasonId;
        if (phaseOf[sid] != Phase.Launch) revert WrongPhase();
        // Audit: bugbot M PR #88. An aborted season stays in Phase.Launch (terminal)
        // but must NOT accept further protocol launches — the deployed token would be
        // orphaned (no Filter/Finals/Settlement runs). Mirrors the community `reserve`
        // gate which already rejects aborted seasons.
        if (aborted[sid]) revert SeasonAlreadyAborted();
        // Audit: bugbot M PR #88. Normalise via TickerLib so the protocol path produces
        // the SAME canonical hash as the community `reserve` path (which always normalises).
        // Pre-fix `keccak256(bytes(symbol_))` on raw `"Filter"` would not collide with
        // community `keccak256(bytes("FILTER"))`, leaving a community re-launch of the same
        // ticker possible; SeasonVault.submitWinner reads `token.symbol()` directly, so we
        // also pass the canonical form into the factory deploy so the deployed ERC-20's
        // symbol IS the canonical pre-image.
        string memory canonicalSymbol = TickerLib.normalize(symbol_);
        bytes32 tickerHash = keccak256(bytes(canonicalSymbol));
        // Protocol launch is allowed to use a blocklisted ticker (e.g. FILTER itself) but is
        // still subject to the per-season uniqueness check — two protocol tokens with the
        // same symbol in one season would be a configuration error.
        if (seasonTickers[sid][tickerHash] != address(0)) revert DuplicateSymbol();
        seasonTickers[sid][tickerHash] = msg.sender;
        (token, locker,) = factory.deployToken(
            IFilterFactory.DeployArgs({
                name: name_,
                symbol: canonicalSymbol,
                metadataURI: metadataURI_,
                creator: msg.sender,
                seasonVault: vaultOf[sid],
                treasury: treasury,
                mechanics: mechanics
            })
        );
        _entry[sid][token] = TokenEntry({
            token: token,
            pool: address(0),
            feeSplitter: locker,
            creator: msg.sender,
            isProtocolLaunched: true,
            isFinalist: false
        });
        _tokens[sid].push(token);
        creatorRegistry.register(token, msg.sender);
        creatorFeeDistributor.registerToken(token, sid);
        // Audit: bugbot M PR #88. Emit `canonicalSymbol` so the indexer's `TokenLaunched`
        // payload matches the deployed ERC-20's actual `symbol()` (which is canonical).
        emit TokenLaunched(
            sid, token, locker, msg.sender, true, type(uint64).max, 0, name_, canonicalSymbol, metadataURI_
        );
    }

    // ============================================================ Soft-filter hook
    // The post-deploy soft-filter resolution lives on `LauncherStakeAdmin` (deployed inline
    // and exposed via `launcher.stakeAdmin()`). The oracle calls
    // `stakeAdmin.applySoftFilter(...)` directly. State + ETH balance for stakes lives there.

    // ============================================================ Pricing (internal)

    /// @dev Cost of slot `slotIndex` in wei: `BASE * (1 + (slotIndex / MAX_LAUNCHES)^2)`.
    ///      External callers use `lens.launchCost(...)`.
    function _slotCost(uint64 slotIndex) internal view returns (uint256) {
        uint256 m = MAX_LAUNCHES;
        uint256 s = uint256(slotIndex);
        return (baseLaunchCost * (m * m + s * s)) / (m * m);
    }

    // ============================================================ Views

    /// @notice Spec §46 ticker-availability lookup + composite reservation/launch views are
    ///         intentionally OFF the launcher. `canReserve`, `getLaunchStatus`, and
    ///         `getLaunchSlots` live on the inline-deployed `LauncherLens` (call
    ///         `launcher.lens()` to access them); the indexer's
    ///         `/season/:id/tickers/check` endpoint (Epic 1.15b) ports `TickerLib.normalize`
    ///         to TypeScript and reads the launcher's `tickerBlocklist` / `winnerTickers` /
    ///         `seasonTickers` mappings directly. Replicating this on-chain pushed the
    ///         launcher past EIP-170; the lens + indexer are the right homes since it's pure
    ///         convenience for the UX (the contract's `reserve` is always the authority).

    function tokensInSeason(uint256 seasonId) external view override returns (address[] memory) {
        return _tokens[seasonId];
    }

    function entryOf(uint256 seasonId, address token) external view override returns (TokenEntry memory) {
        return _entry[seasonId][token];
    }

    function launchInfoOf(uint256 seasonId, address token)
        external
        view
        override
        returns (LaunchInfo memory)
    {
        return stakeAdmin.launchInfoOf(seasonId, token);
    }

    function pendingReservations(uint256 seasonId) external view returns (PendingReservation[] memory) {
        return _pending[seasonId];
    }

    function lockerOf(uint256 seasonId, address token) external view returns (address) {
        return _entry[seasonId][token].feeSplitter;
    }

    // ============================================================ Pause

    function setPaused(bool paused_) external onlyOwner {
        if (paused_) _pause();
        else _unpause();
    }

    /// @notice Allow the LaunchEscrow to deposit released funds back here. The launcher's
    ///         deploy path either holds (refundable stake mode) or forwards (fee mode) what
    ///         comes through; the existing `applySoftFilter` path then refunds creators or
    ///         routes to `forfeitRecipient`. Without this receive, `releaseToDeploy` would
    ///         revert because we can't accept ETH from the escrow's `call`.
    receive() external payable {}
}
