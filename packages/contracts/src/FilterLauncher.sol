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
import {TournamentRegistry} from "./TournamentRegistry.sol";
import {TournamentVault, ITournamentRegistryView, ICreatorRegistryView} from "./TournamentVault.sol";
import {IFilterFactory} from "./interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "./interfaces/IFilterLauncher.sol";

/// @title FilterLauncher
/// @notice Top-level entry point. Owns the season state machine, the capped 12-slot weekly
///         launch window with dynamic pricing + refundable stake, and the address of the
///         singleton `IFilterFactory`. Also creates each season's `SeasonVault`. Phase
///         transitions are oracle-gated.
contract FilterLauncher is IFilterLauncher, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeCast for uint256;

    error WrongPhase();
    error LaunchCapReached();
    error LaunchWindowClosed();
    error InsufficientPayment();
    error DuplicateSymbol();
    error NotOracle();
    error UnknownToken();
    error SeasonAlreadyOpen();
    error RefundFailed();
    error AlreadyResolved();
    error ZeroAddress();

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
    event StakeRefunded(
        uint256 indexed seasonId, address indexed token, address indexed creator, uint256 amount
    );
    event StakeForfeited(
        uint256 indexed seasonId, address indexed token, address indexed creator, uint256 amount
    );
    event PhaseAdvanced(uint256 indexed seasonId, Phase newPhase);
    event FinalistsSet(uint256 indexed seasonId, address[] finalists);
    event WinnerSet(uint256 indexed seasonId, address winner);
    event BaseLaunchCostUpdated(uint256 cost);
    event RefundableStakeToggled(bool enabled);
    event ForfeitRecipientUpdated(address recipient);

    // ============================================================ Constants

    /// @notice Hard cap on launches per weekly season. The launch window also closes early
    ///         when this is hit.
    uint256 public constant MAX_LAUNCHES = 12;
    /// @notice Maximum length of the launch window from `startSeason`.
    uint256 public constant LAUNCH_WINDOW_DURATION = 48 hours;

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

    /// @notice Singleton creator contracts. Both deployed inline by this launcher's constructor
    ///         so `address(this)` resolves cleanly without a chicken-and-egg constructor ordering.
    ///         The factory reads `creatorFeeDistributor` post-construction to wire each per-token
    ///         locker.
    CreatorRegistry public immutable creatorRegistry;
    CreatorFeeDistributor public immutable creatorFeeDistributor;
    /// @notice Singleton tournament metadata registry. Tracks per-token status across the
    ///         weekly → quarterly Filter Bowl → annual championship ladder. Deployed inline
    ///         here so SeasonVault can record weekly winners + filtered tokens without a
    ///         post-construction wire-up step.
    TournamentRegistry public immutable tournamentRegistry;
    /// @notice Singleton quarterly Filter Bowl settlement vault. Per-(year, quarter) escrow
    ///         + 45/25/10/10/10 + 2.5% bounty distribution + Merkle rollover/bonus claims.
    ///         Deployed inline here so the registry + vault are wired without a
    ///         post-construction step. POL deployment for tournament settlements is
    ///         intentionally not wired here yet (deferred to follow-up).
    TournamentVault public immutable tournamentVault;
    uint256 public bonusUnlockDelay = 14 days;
    uint256 public maxLaunchesPerWallet = 2;

    // ============================================================ Launch-window config

    /// @notice Base cost of slot 0 in wei. Slot N is `BASE * (1 + (N/MAX)^2)`.
    uint256 public baseLaunchCost = 0.05 ether;
    /// @notice When true, `launchToken` retains the cost as a refundable stake until the
    ///         soft-filter resolves. When false, the cost flows to `treasury` immediately.
    bool public refundableStakeEnabled = true;
    /// @notice Recipient of forfeited stakes (and of the launch fee when stake mode is off).
    ///         Defaults to `treasury`; owner can route to a prize pool or vault.
    address public forfeitRecipient;

    // ============================================================ Season state

    uint256 public override currentSeasonId;
    mapping(uint256 => Phase) internal _phase;
    mapping(uint256 => address) internal _vault;
    mapping(uint256 => address[]) internal _tokens;
    mapping(uint256 => mapping(address => TokenEntry)) internal _entry;
    mapping(uint256 => mapping(address => LaunchInfo)) internal _launchInfo;
    mapping(uint256 => mapping(address => uint256)) public launchesByWallet;
    /// @notice Symbol-collision guard, scoped per season. Hash of `bytes(symbol)`.
    mapping(uint256 => mapping(bytes32 => bool)) internal _symbolUsed;

    /// @notice Number of public-launch slots filled. Protocol-launched tokens do NOT count.
    mapping(uint256 => uint64) public launchCount;
    mapping(uint256 => uint256) public launchStartTime;
    mapping(uint256 => uint256) public launchEndTime;
    /// @notice Set true once a launch window has emitted `LaunchClosed` (via cap-fill or
    ///         oracle close). Prevents duplicate close events.
    mapping(uint256 => bool) internal _launchClosedEmitted;

    constructor(
        address owner_,
        address oracle_,
        address treasury_,
        address mechanics_,
        IBonusFunding bonusDistributor_,
        address weth_
    ) Ownable(owner_) {
        oracle = oracle_;
        treasury = treasury_;
        mechanics = mechanics_;
        bonusDistributor = bonusDistributor_;
        weth = weth_;
        forfeitRecipient = treasury_;
        creatorRegistry = new CreatorRegistry(address(this));
        creatorFeeDistributor = new CreatorFeeDistributor(address(this), weth_, treasury_, creatorRegistry);
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
    }

    /// @notice One-shot wire of the POLManager. Owner-only; reverts if already set or zero.
    ///         Required because POLManager wants the launcher's address in its constructor —
    ///         we deploy POLManager after the launcher and call this to close the loop.
    function setPolManager(IPOLManager polManager_) external onlyOwner {
        require(address(polManager) == address(0), "polManager set");
        require(address(polManager_) != address(0), "zero polManager");
        polManager = polManager_;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    function setFactory(IFilterFactory factory_) external onlyOwner {
        require(address(factory) == address(0), "factory set");
        factory = factory_;
    }

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
    }

    function setBonusUnlockDelay(uint256 delay_) external onlyOwner {
        bonusUnlockDelay = delay_;
    }

    function setMaxLaunchesPerWallet(uint256 cap_) external onlyOwner {
        maxLaunchesPerWallet = cap_;
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
            oracle,
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
        // Allow only forward, ordered transitions.
        require(uint8(target) == uint8(cur) + 1, "bad transition");
        _phase[seasonId] = target;
        // Leaving Launch: emit LaunchClosed if not already.
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

    // ============================================================ Token launch

    /// @notice Permissionless capped launch. Caller must include the dynamic slot cost as
    ///         `msg.value`; excess is refunded. When `refundableStakeEnabled` is true the
    ///         cost is held as a stake until the soft-filter resolves (refund or forfeit);
    ///         otherwise it flows to `treasury` immediately as a launch fee.
    function launchToken(string calldata name_, string calldata symbol_, string calldata metadataURI_)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (address token, address locker)
    {
        uint256 sid = currentSeasonId;
        if (_phase[sid] != Phase.Launch) revert WrongPhase();
        if (block.timestamp >= launchEndTime[sid]) revert LaunchWindowClosed();
        if (launchCount[sid] >= MAX_LAUNCHES) revert LaunchCapReached();
        if (launchesByWallet[sid][msg.sender] >= maxLaunchesPerWallet) revert LaunchCapReached();

        uint64 slotIndex = launchCount[sid];
        uint256 cost = _launchCost(slotIndex);
        if (msg.value < cost) revert InsufficientPayment();

        bytes32 symHash = keccak256(bytes(symbol_));
        if (_symbolUsed[sid][symHash]) revert DuplicateSymbol();
        _symbolUsed[sid][symHash] = true;

        ++launchesByWallet[sid][msg.sender];
        launchCount[sid] = slotIndex + 1;

        (token, locker,) = _launch(sid, name_, symbol_, metadataURI_, msg.sender, false);

        // SafeCast: reverts if cost overflows uint128 (≈3.4e20 ETH — only reachable with a
        // pathological `baseLaunchCost`, but we'd rather revert than silently truncate).
        uint128 costAsU128 = cost.toUint128();
        uint128 stakeAmount;
        if (refundableStakeEnabled) {
            stakeAmount = costAsU128;
        } else {
            // Fee mode: forward to treasury immediately. Use forfeitRecipient (defaults to
            // treasury) so the owner can re-route launch fees the same way as forfeitures.
            (bool ok,) = forfeitRecipient.call{value: cost}("");
            if (!ok) revert RefundFailed();
        }

        _launchInfo[sid][token] = LaunchInfo({
            slotIndex: slotIndex,
            costPaid: costAsU128,
            stakeAmount: stakeAmount,
            refunded: false,
            filteredEarly: false
        });

        emit TokenLaunched(
            sid, token, locker, msg.sender, false, slotIndex, cost, name_, symbol_, metadataURI_
        );
        emit LaunchSlotFilled(sid, slotIndex);

        // Cap-fill auto-closes the window.
        if (launchCount[sid] == MAX_LAUNCHES && !_launchClosedEmitted[sid]) {
            _launchClosedEmitted[sid] = true;
            emit LaunchClosed(sid, MAX_LAUNCHES);
        }

        // Refund any excess.
        uint256 excess = msg.value - cost;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Owner-only path for $FILTER and any other protocol-launched seed tokens. Bypasses
    ///         the slot cap, the per-wallet cap, and the dynamic cost; otherwise identical to
    ///         `launchToken`. Protocol launches are NOT counted toward `launchCount`.
    function launchProtocolToken(string calldata name_, string calldata symbol_, string calldata metadataURI_)
        external
        onlyOwner
        whenNotPaused
        returns (address token, address locker)
    {
        uint256 sid = currentSeasonId;
        if (_phase[sid] != Phase.Launch) revert WrongPhase();
        bytes32 symHash = keccak256(bytes(symbol_));
        if (_symbolUsed[sid][symHash]) revert DuplicateSymbol();
        _symbolUsed[sid][symHash] = true;
        (token, locker,) = _launch(sid, name_, symbol_, metadataURI_, msg.sender, true);
        emit TokenLaunched(
            sid, token, locker, msg.sender, true, type(uint64).max, 0, name_, symbol_, metadataURI_
        );
    }

    /// @dev `sid` is plumbed through from the caller so every storage write in this call
    ///      keys off the same season identifier as the caller's pre-flight checks. Reading
    ///      `currentSeasonId` again here would split state across two access paths if anything
    ///      ever advances the cursor mid-call.
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
            pool: address(0), // V4 pools are keyed, no address; left zero for compatibility
            feeSplitter: locker,
            creator: creator,
            isProtocolLaunched: isProtocolLaunched,
            isFinalist: false
        });
        _tokens[sid].push(token);

        // Register (token, creator, launchedAt) and the seasonId mapping the distributor
        // uses for its own auth checks. Both contracts revert on duplicate token, so any
        // future token-deployment path that reuses the same address is rejected here too.
        creatorRegistry.register(token, creator);
        creatorFeeDistributor.registerToken(token, sid);
    }

    // ============================================================ Soft-filter hook

    /// @notice Resolve the refundable-stake outcome for a batch of launched tokens. Survivors
    ///         get their stake refunded to the original creator; forfeitures forward the stake
    ///         to `forfeitRecipient` and mark `filteredEarly`.
    /// @dev    Oracle-driven so it composes with the existing phase machine. Idempotent per
    ///         token: a second resolution attempt reverts. Protocol-launched tokens have no
    ///         stake, so passing them is a no-op-equivalent revert (`AlreadyResolved` from a
    ///         zero stake).
    function applySoftFilter(uint256 seasonId, address[] calldata survivors, address[] calldata forfeited)
        external
        onlyOracle
        nonReentrant
    {
        // Soft filter applies once Launch is over — i.e. Filter or beyond.
        Phase p = _phase[seasonId];
        if (p == Phase.Launch || p == Phase(0)) revert WrongPhase();

        for (uint256 i = 0; i < survivors.length; ++i) {
            address t = survivors[i];
            TokenEntry storage entry = _entry[seasonId][t];
            // Token must exist in this season AND have come through the public-launch path.
            // Protocol launches don't carry a stake. Using `entry.token` as the existence
            // sentinel keeps this resolution sound even if `baseLaunchCost` is set to zero.
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
    ///         Computed as `BASE * (MAX^2 + slot^2) / MAX^2` to stay in integer math.
    function launchCost(uint256 slotIndex) external view returns (uint256) {
        return _launchCost(uint64(slotIndex));
    }

    function _launchCost(uint64 slotIndex) internal view returns (uint256) {
        uint256 m = MAX_LAUNCHES;
        uint256 s = uint256(slotIndex);
        return (baseLaunchCost * (m * m + s * s)) / (m * m);
    }

    // ============================================================ Views

    function canLaunch() external view returns (bool) {
        if (paused()) return false;
        uint256 sid = currentSeasonId;
        if (_phase[sid] != Phase.Launch) return false;
        if (block.timestamp >= launchEndTime[sid]) return false;
        if (launchCount[sid] >= MAX_LAUNCHES) return false;
        return true;
    }

    function getLaunchStatus(uint256 seasonId) external view returns (LaunchStatus memory s) {
        s.launchCount = launchCount[seasonId];
        s.maxLaunches = MAX_LAUNCHES;
        uint256 endT = launchEndTime[seasonId];
        s.timeRemaining = block.timestamp >= endT ? 0 : endT - block.timestamp;
        if (s.launchCount < MAX_LAUNCHES) {
            s.nextLaunchCost = _launchCost(uint64(s.launchCount));
        } else {
            s.nextLaunchCost = 0;
        }
    }

    /// @notice Returns parallel arrays describing every public-launch slot filled in `seasonId`.
    ///         Protocol-launched tokens are excluded (they have no slot).
    function getLaunchSlots(uint256 seasonId)
        external
        view
        returns (address[] memory tokens, uint64[] memory slotIndexes, address[] memory creators)
    {
        address[] storage all = _tokens[seasonId];
        uint256 n = all.length;
        // Pre-count public launches.
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
}
