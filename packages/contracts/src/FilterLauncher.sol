// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

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
import {TournamentVault, ITournamentRegistryView, ICreatorRegistryView} from "./TournamentVault.sol";
import {IFilterFactory} from "./interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "./interfaces/IFilterLauncher.sol";
import {LaunchEscrow} from "./LaunchEscrow.sol";
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
contract FilterLauncher is IFilterLauncher, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeCast for uint256;

    // ============================================================ Errors

    error WrongPhase();
    error WindowClosed();
    error WindowStillOpen();
    error SlotsExhausted();
    error InsufficientEscrow();
    error AlreadyReserved();
    error TickerTaken(uint256 seasonId, bytes32 tickerHash);
    error TickerBlocklisted(bytes32 tickerHash);
    error TickerWinnerReserved(bytes32 tickerHash);
    error NotOracle();
    error NotMultisig();
    error NotSeasonVault();
    error UnknownToken();
    error SeasonAlreadyOpen();
    error SeasonAlreadyAborted();
    error SeasonAlreadyActivated();
    error SeasonNotActivated();
    error AlreadyResolved();
    error RefundFailed();
    error ZeroAddress();
    error DuplicateSymbol();

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
    event LaunchSlotFilled(uint256 indexed seasonId, uint64 slotIndex);
    event LaunchClosed(uint256 indexed seasonId, uint256 filledSlots);
    event SeasonActivated(
        uint256 indexed seasonId, uint256 activatedAt, address[] deployedTokens
    );
    event SeasonAborted(
        uint256 indexed seasonId, uint256 reservationCount, uint256 totalRefunded
    );
    event StakeRefunded(
        uint256 indexed seasonId, address indexed token, address indexed creator, uint256 amount
    );
    event StakeForfeited(
        uint256 indexed seasonId, address indexed token, address indexed creator, uint256 amount
    );
    event PhaseAdvanced(uint256 indexed seasonId, Phase newPhase);
    event FinalistsSet(uint256 indexed seasonId, address[] finalists);
    event WinnerSet(uint256 indexed seasonId, address winner);
    event TickerBlocked(bytes32 indexed tickerHash, address indexed by);
    event WinnerTickerReserved(uint256 indexed seasonId, bytes32 indexed tickerHash, address indexed winnerToken);
    event BaseLaunchCostUpdated(uint256 cost);
    event RefundableStakeToggled(bool enabled);
    event ForfeitRecipientUpdated(address recipient);
    /// @notice Emitted exactly once per launcher deploy when the FilterFactory is wired.
    event FactorySet(address indexed factory);

    // ============================================================ Constants

    /// @notice Hard cap on reservations (and therefore deployed tokens) per weekly season.
    uint256 public constant MAX_LAUNCHES = 12;
    /// @notice Maximum length of the launch window from `startSeason`.
    uint256 public constant LAUNCH_WINDOW_DURATION = 48 hours;
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

    /// @notice Singleton creator contracts (deployed inline to break constructor circularity).
    CreatorRegistry public immutable creatorRegistry;
    CreatorFeeDistributor public immutable creatorFeeDistributor;
    CreatorCommitments public immutable creatorCommitments;
    TournamentRegistry public immutable tournamentRegistry;
    TournamentVault public immutable tournamentVault;
    uint256 public bonusUnlockDelay = 14 days;

    // ============================================================ Launch-window config

    /// @notice Base cost of slot 0 in wei. Slot N is `BASE * (1 + (N/MAX)^2)`.
    uint256 public baseLaunchCost = 0.05 ether;
    /// @notice When true, the slot cost released from escrow at deploy time is held by this
    ///         contract as a refundable stake until the soft-filter resolves; when false, it
    ///         flows to `forfeitRecipient` immediately as a launch fee.
    bool public refundableStakeEnabled = true;
    /// @notice Recipient of forfeited stakes (and of the launch fee when stake mode is off).
    address public forfeitRecipient;

    // ============================================================ Season state

    uint256 public override currentSeasonId;
    mapping(uint256 => Phase) internal _phase;
    mapping(uint256 => address) internal _vault;
    mapping(uint256 => address[]) internal _tokens;
    mapping(uint256 => mapping(address => TokenEntry)) internal _entry;
    mapping(uint256 => mapping(address => LaunchInfo)) internal _launchInfo;

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
        tournamentRegistry = new TournamentRegistry(address(this));
        tournamentVault = new TournamentVault(
            address(this),
            weth_,
            treasury_,
            mechanics_,
            ITournamentRegistryView(address(tournamentRegistry)),
            ICreatorRegistryView(address(creatorRegistry)),
            bonusUnlockDelay
        );
        // Spec §46: every reservation routes ETH through this contract until activation or
        // abort. Deployed inline so the launcher↔escrow handshake is structural — neither can
        // exist without the other.
        launchEscrow = new LaunchEscrow(address(this));

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
        require(address(polManager) == address(0), "polManager set");
        if (address(polManager_) == address(0)) revert ZeroAddress();
        polManager = polManager_;
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
        require(address(factory) == address(0), "factory set");
        if (address(factory_) == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(address(factory_));
    }

    /// @notice Rotate the oracle authorised to drive season lifecycle + filter events.
    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = oracle_;
    }

    function setBonusUnlockDelay(uint256 delay_) external onlyOwner {
        bonusUnlockDelay = delay_;
    }

    function setBaseLaunchCost(uint256 cost_) external onlyOwner {
        baseLaunchCost = cost_;
        emit BaseLaunchCostUpdated(cost_);
    }

    function setRefundableStakeEnabled(bool enabled_) external onlyOwner {
        refundableStakeEnabled = enabled_;
        emit RefundableStakeToggled(enabled_);
    }

    function setForfeitRecipient(address recipient_) external onlyOwner {
        if (recipient_ == address(0)) revert ZeroAddress();
        forfeitRecipient = recipient_;
        emit ForfeitRecipientUpdated(recipient_);
    }

    /// @notice Append a ticker hash to the protocol blocklist. One-way — there is no
    ///         corresponding remove, by design (spec §4.6.1).
    function addTickerToBlocklist(bytes32 tickerHash) external onlyMultisig {
        tickerBlocklist[tickerHash] = true;
        emit TickerBlocked(tickerHash, msg.sender);
    }

    /// @notice Permanently reserve a ticker for the cross-season pool. Called by the season's
    ///         vault from `submitWinner` so the winning ticker is locked before the next
    ///         season opens. The vault is auth'd by `_vault[seasonId] == msg.sender`; the
    ///         vault itself reads `seasonId` from immutable state, so a stale or third-party
    ///         caller can't poison the winner table.
    function setWinnerTicker(uint256 seasonId, bytes32 tickerHash, address winnerToken) external {
        if (msg.sender != _vault[seasonId]) revert NotSeasonVault();
        // Idempotent: if the same hash is already mapped to the same token, no-op. A different
        // token-for-same-hash would mean two different winners with the same ticker hash —
        // structurally impossible because seasonTickers prevents same-season collisions and
        // the cross-season `winnerTickers` reservation prevents future-season collisions.
        if (winnerTickers[tickerHash] != address(0) && winnerTickers[tickerHash] != winnerToken) {
            revert TickerWinnerReserved(tickerHash);
        }
        winnerTickers[tickerHash] = winnerToken;
        emit WinnerTickerReserved(seasonId, tickerHash, winnerToken);
    }

    // ============================================================ Season lifecycle

    /// @notice Opens a new season. Deploys its `SeasonVault` and starts the 48h launch window.
    function startSeason() external onlyOracle whenNotPaused returns (uint256 seasonId) {
        require(address(polManager) != address(0), "polManager unset");
        seasonId = ++currentSeasonId;
        if (_phase[seasonId] != Phase.Launch && _phase[seasonId] != Phase(0)) revert SeasonAlreadyOpen();

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
        _vault[seasonId] = address(v);
        _phase[seasonId] = Phase.Launch;
        launchStartTime[seasonId] = block.timestamp;
        launchEndTime[seasonId] = block.timestamp + LAUNCH_WINDOW_DURATION;
        emit SeasonStarted(seasonId, address(v), launchStartTime[seasonId], launchEndTime[seasonId]);
    }

    function advancePhase(uint256 seasonId, Phase target) external onlyOracle whenNotPaused {
        Phase cur = _phase[seasonId];
        require(uint8(target) == uint8(cur) + 1, "bad transition");
        // Refuse to leave Launch on a season that never activated and hasn't been formally
        // aborted — that would silently bury the abort path. Operator runbook: if the season
        // is sparse, call `abortSeason` first; THEN advance.
        if (cur == Phase.Launch && !activated[seasonId] && !aborted[seasonId]) {
            revert SeasonNotActivated();
        }
        _phase[seasonId] = target;
        if (cur == Phase.Launch && !_launchClosedEmitted[seasonId]) {
            _launchClosedEmitted[seasonId] = true;
            emit LaunchClosed(seasonId, launchCount[seasonId]);
        }
        emit PhaseAdvanced(seasonId, target);
    }

    function setFinalists(uint256 seasonId, address[] calldata finalists) external onlyOracle whenNotPaused {
        if (_phase[seasonId] != Phase.Filter) revert WrongPhase();
        for (uint256 i = 0; i < finalists.length; ++i) {
            address t = finalists[i];
            if (_entry[seasonId][t].token == address(0)) revert UnknownToken();
            _entry[seasonId][t].isFinalist = true;
        }
        emit FinalistsSet(seasonId, finalists);
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
        if (_phase[sid] != Phase.Launch) revert WrongPhase();
        if (aborted[sid]) revert SeasonAlreadyAborted();
        if (block.timestamp >= launchEndTime[sid]) revert WindowClosed();

        // 1. Per-wallet cap: structural in LaunchEscrow.escrows[sid][creator]. Reading via
        //    the public getter rather than reaching into private state.
        LaunchEscrow.Reservation memory existing = launchEscrow.escrowOf(sid, msg.sender);
        if (existing.amount != 0) revert AlreadyReserved();

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
        if (tickerBlocklist[tickerHash]) revert TickerBlocklisted(tickerHash);

        // 6. Cross-season winner reservation.
        if (winnerTickers[tickerHash] != address(0)) revert TickerWinnerReserved(tickerHash);

        // 7. Per-season uniqueness.
        if (seasonTickers[sid][tickerHash] != address(0)) revert TickerTaken(sid, tickerHash);

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
        require(n == ACTIVATION_THRESHOLD, "activate: pending != threshold");

        address[] memory deployed = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            // Copy to memory before _deployToken since the loop will iterate against storage
            // we don't otherwise mutate, and `_deployToken` doesn't write to `_pending`.
            PendingReservation memory pr = queue[i];
            deployed[i] = _deployToken(sid, pr);
        }
        delete _pending[sid];

        emit SeasonActivated(sid, block.timestamp, deployed);
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
                seasonVault: _vault[sid],
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

        // Apply the stake-vs-fee toggle to the recovered ETH. In stake mode we hold; in fee
        // mode we forward to forfeitRecipient (treasury default).
        uint128 costAsU128 = amount.toUint128();
        uint128 stakeAmount;
        if (refundableStakeEnabled) {
            stakeAmount = costAsU128;
        } else {
            (bool ok,) = forfeitRecipient.call{value: amount}("");
            if (!ok) revert RefundFailed();
        }

        _launchInfo[sid][token] = LaunchInfo({
            slotIndex: pr.slotIndex,
            costPaid: costAsU128,
            stakeAmount: stakeAmount,
            refunded: false,
            filteredEarly: false
        });

        launchCount[sid] = uint64(uint256(launchCount[sid]) + 1);

        emit TokenLaunched(
            sid, token, locker, pr.creator, false, pr.slotIndex, amount, pr.ticker, pr.ticker, pr.metadataURI
        );
        emit LaunchSlotFilled(sid, pr.slotIndex);
    }

    /// @notice Abort a sparse season: at h48 with `activated == false`, sweep escrow refunds
    ///         and mark the season aborted. Oracle-gated — production scheduler EOA is the
    ///         oracle, so the same lifecycle authority owns this terminal transition.
    function abortSeason(uint256 seasonId) external onlyOracle nonReentrant {
        if (block.timestamp < launchEndTime[seasonId]) revert WindowStillOpen();
        if (activated[seasonId]) revert SeasonAlreadyActivated();
        if (aborted[seasonId]) revert SeasonAlreadyAborted();

        aborted[seasonId] = true;

        (uint256 resCount, uint256 totalRefunded) = launchEscrow.refundAll(seasonId);

        // The launch window already ended (window-still-open check above); fire LaunchClosed
        // exactly once if it hasn't yet. `launchCount` is 0 here by construction (no token
        // deployed), so the close fires with count = 0.
        if (!_launchClosedEmitted[seasonId]) {
            _launchClosedEmitted[seasonId] = true;
            emit LaunchClosed(seasonId, 0);
        }

        // Drop any queued pending entries — they're refunded above; this just frees storage.
        delete _pending[seasonId];

        emit SeasonAborted(seasonId, resCount, totalRefunded);
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
        if (_phase[sid] != Phase.Launch) revert WrongPhase();
        bytes32 tickerHash = keccak256(bytes(symbol_));
        // Protocol launch is allowed to use a blocklisted ticker (e.g. FILTER itself) but is
        // still subject to the per-season uniqueness check — two protocol tokens with the
        // same symbol in one season would be a configuration error.
        if (seasonTickers[sid][tickerHash] != address(0)) revert DuplicateSymbol();
        seasonTickers[sid][tickerHash] = msg.sender;
        (token, locker,) = _launch(sid, name_, symbol_, metadataURI_, msg.sender, true);
        emit TokenLaunched(
            sid, token, locker, msg.sender, true, type(uint64).max, 0, name_, symbol_, metadataURI_
        );
    }

    /// @dev Shared deploy helper for protocol launches. The reservation flow uses
    ///      `_deployToken` instead because it threads escrow-release + stake bookkeeping.
    function _launch(
        uint256 sid,
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        address creator,
        bool isProtocolLaunched
    ) internal returns (address token, address locker, PoolKey memory key) {
        (token, locker, key) = factory.deployToken(
            IFilterFactory.DeployArgs({
                name: name_,
                symbol: symbol_,
                metadataURI: metadataURI_,
                creator: creator,
                seasonVault: _vault[sid],
                treasury: treasury,
                mechanics: mechanics
            })
        );
        _entry[sid][token] = TokenEntry({
            token: token,
            pool: address(0),
            feeSplitter: locker,
            creator: creator,
            isProtocolLaunched: isProtocolLaunched,
            isFinalist: false
        });
        _tokens[sid].push(token);

        creatorRegistry.register(token, creator);
        creatorFeeDistributor.registerToken(token, sid);
    }

    // ============================================================ Soft-filter hook

    /// @notice Resolve the refundable-stake outcome for a batch of launched tokens. Survivors
    ///         get their stake refunded to the original creator; forfeitures forward the stake
    ///         to `forfeitRecipient` and mark `filteredEarly`.
    function applySoftFilter(uint256 seasonId, address[] calldata survivors, address[] calldata forfeited)
        external
        onlyOracle
        nonReentrant
    {
        Phase p = _phase[seasonId];
        if (p == Phase.Launch || p == Phase(0)) revert WrongPhase();

        for (uint256 i = 0; i < survivors.length; ++i) {
            address t = survivors[i];
            TokenEntry storage entry = _entry[seasonId][t];
            if (entry.token == address(0) || entry.isProtocolLaunched) revert UnknownToken();
            LaunchInfo storage info = _launchInfo[seasonId][t];
            if (info.refunded || info.filteredEarly) revert AlreadyResolved();
            uint256 amount = info.stakeAmount;
            info.refunded = true;
            info.stakeAmount = 0;
            address creator = entry.creator;
            if (amount > 0) {
                (bool ok,) = creator.call{value: amount}("");
                if (!ok) revert RefundFailed();
            }
            emit StakeRefunded(seasonId, t, creator, amount);
        }

        for (uint256 i = 0; i < forfeited.length; ++i) {
            address t = forfeited[i];
            TokenEntry storage entry = _entry[seasonId][t];
            if (entry.token == address(0) || entry.isProtocolLaunched) revert UnknownToken();
            LaunchInfo storage info = _launchInfo[seasonId][t];
            if (info.refunded || info.filteredEarly) revert AlreadyResolved();
            uint256 amount = info.stakeAmount;
            info.filteredEarly = true;
            info.stakeAmount = 0;
            address creator = entry.creator;
            if (amount > 0) {
                (bool ok,) = forfeitRecipient.call{value: amount}("");
                if (!ok) revert RefundFailed();
            }
            emit StakeForfeited(seasonId, t, creator, amount);
        }
    }

    // ============================================================ Pricing

    /// @notice Cost of slot `slotIndex` in wei: `BASE * (1 + (slotIndex / MAX_LAUNCHES)^2)`.
    function launchCost(uint256 slotIndex) external view returns (uint256) {
        return _slotCost(uint64(slotIndex));
    }

    /// @notice Spec §46 alias. Same math; clearer name in the deferred-activation API surface.
    function slotCost(uint256 slotIndex) external view returns (uint256) {
        return _slotCost(uint64(slotIndex));
    }

    function _slotCost(uint64 slotIndex) internal view returns (uint256) {
        uint256 m = MAX_LAUNCHES;
        uint256 s = uint256(slotIndex);
        return (baseLaunchCost * (m * m + s * s)) / (m * m);
    }

    /// @notice Spec §46 cut helper: with `n` reservations active, the bottom 50% (rounded
    ///         DOWN) get cut, leaving the top ⌈n/2⌉ as survivors. Symmetric with the indexer
    ///         + frontend so all three sides agree on cut size at any N.
    function expectedSurvivorCount(uint256 reservationCount_) external pure returns (uint256) {
        return reservationCount_ - (reservationCount_ / 2);
    }

    // ============================================================ Views

    function reservationCount(uint256 seasonId) external view returns (uint256) {
        return launchEscrow.reservationCountOf(seasonId);
    }

    /// @notice Phase classification per spec §46 + indexer contract:
    ///           "reservation" — Launch phase, not yet activated, not aborted
    ///           "trading"     — Launch phase, activated (cohort live, window may still be open)
    ///           "filter"      — Filter phase
    ///           "finals"      — Finals phase
    ///           "settled"     — Settlement / Closed phase
    ///           "aborted"     — abort sweep ran
    ///         Indexer derives the same string from these flags.
    function canReserve() external view returns (bool) {
        if (paused()) return false;
        uint256 sid = currentSeasonId;
        if (_phase[sid] != Phase.Launch) return false;
        if (aborted[sid]) return false;
        if (block.timestamp >= launchEndTime[sid]) return false;
        if (launchEscrow.reservationCountOf(sid) >= MAX_LAUNCHES) return false;
        return true;
    }

    /// @notice Spec §46 view: is `ticker` available for `seasonId` per all four ticker rules?
    ///         Mirror of the eight-step validation steps 4..7 (no funds/cap checks). Used by
    ///         the frontend's debounced live-availability check so the user sees an immediate
    ///         red/green light without sending a tx. The contract is still the authority —
    ///         `reserve` re-validates at submit time.
    function tickerAvailability(uint256 seasonId, string calldata ticker)
        external
        view
        returns (bool available, bytes32 tickerHash, bytes32 reason)
    {
        // Reasons returned as bytes32 sentinels rather than an enum so the off-chain check
        // stays stable across solc versions and downstream consumers can match on the literal.
        // "available" — caller maps null → green light.
        // The TickerLib normalisation reverts on bad format; we trap the revert via try/catch
        // in solc 0.8 calldata-string semantics: if hashing reverts, the reason is "format".
        // Solc has no try/catch on internal calls though, so we replicate the validator.
        (bytes32 h, bool valid) = _tryHash(ticker);
        tickerHash = h;
        if (!valid) {
            return (false, bytes32(0), keccak256("invalid-format"));
        }
        if (tickerBlocklist[h]) {
            return (false, h, keccak256("blocklist"));
        }
        if (winnerTickers[h] != address(0)) {
            return (false, h, keccak256("winner-reserved"));
        }
        if (seasonTickers[seasonId][h] != address(0)) {
            return (false, h, keccak256("season-taken"));
        }
        return (true, h, bytes32(0));
    }

    /// @dev Internal mirror of `TickerLib.normalize` that returns a (hash, valid) tuple
    ///      instead of reverting, so the view above can return a structured reason rather
    ///      than aborting. Logic stays in lockstep with TickerLib.
    function _tryHash(string memory ticker) internal pure returns (bytes32, bool) {
        bytes memory raw = bytes(ticker);
        uint256 n = raw.length;
        uint256 start = 0;
        while (start < n && _ws(raw[start])) ++start;
        uint256 end = n;
        while (end > start && _ws(raw[end - 1])) --end;
        if (end > start && raw[start] == 0x24) ++start;
        uint256 trimmedLen = end - start;
        if (trimmedLen < 2 || trimmedLen > 10) return (bytes32(0), false);
        bytes memory out = new bytes(trimmedLen);
        for (uint256 i = 0; i < trimmedLen; ++i) {
            bytes1 b = raw[start + i];
            if (b >= 0x61 && b <= 0x7A) b = bytes1(uint8(b) - 32);
            bool isUpper = (b >= 0x41 && b <= 0x5A);
            bool isDigit = (b >= 0x30 && b <= 0x39);
            if (!isUpper && !isDigit) return (bytes32(0), false);
            out[i] = b;
        }
        return (keccak256(out), true);
    }

    function _ws(bytes1 b) private pure returns (bool) {
        return b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D;
    }

    function getLaunchStatus(uint256 seasonId) external view returns (LaunchStatus memory s) {
        s.launchCount = launchCount[seasonId];
        s.maxLaunches = MAX_LAUNCHES;
        uint256 endT = launchEndTime[seasonId];
        s.timeRemaining = block.timestamp >= endT ? 0 : endT - block.timestamp;
        uint256 res = launchEscrow.reservationCountOf(seasonId);
        if (res < MAX_LAUNCHES) {
            s.nextLaunchCost = _slotCost(uint64(res));
        } else {
            s.nextLaunchCost = 0;
        }
    }

    /// @notice Returns parallel arrays describing every public-launch slot deployed in
    ///         `seasonId`. Pre-activation this returns empty arrays since no public token
    ///         has been deployed yet.
    function getLaunchSlots(uint256 seasonId)
        external
        view
        returns (address[] memory tokens, uint64[] memory slotIndexes, address[] memory creators)
    {
        address[] storage all = _tokens[seasonId];
        uint256 n = all.length;
        uint256 publicCount;
        for (uint256 i = 0; i < n; ++i) {
            if (!_entry[seasonId][all[i]].isProtocolLaunched) ++publicCount;
        }
        tokens = new address[](publicCount);
        slotIndexes = new uint64[](publicCount);
        creators = new address[](publicCount);
        uint256 j;
        for (uint256 i = 0; i < n; ++i) {
            address t = all[i];
            if (_entry[seasonId][t].isProtocolLaunched) continue;
            tokens[j] = t;
            slotIndexes[j] = _launchInfo[seasonId][t].slotIndex;
            creators[j] = _entry[seasonId][t].creator;
            ++j;
        }
    }

    function pendingReservations(uint256 seasonId) external view returns (PendingReservation[] memory) {
        return _pending[seasonId];
    }

    function phaseOf(uint256 seasonId) external view override returns (Phase) {
        return _phase[seasonId];
    }

    function vaultOf(uint256 seasonId) external view override returns (address) {
        return _vault[seasonId];
    }

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
        return _launchInfo[seasonId][token];
    }

    function lockerOf(uint256 seasonId, address token) external view returns (address) {
        return _entry[seasonId][token].feeSplitter;
    }

    // ============================================================ Pause

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Allow the LaunchEscrow to deposit released funds back here. The launcher's
    ///         deploy path either holds (refundable stake mode) or forwards (fee mode) what
    ///         comes through; the existing `applySoftFilter` path then refunds creators or
    ///         routes to `forfeitRecipient`. Without this receive, `releaseToDeploy` would
    ///         revert because we can't accept ETH from the escrow's `call`.
    receive() external payable {}
}
