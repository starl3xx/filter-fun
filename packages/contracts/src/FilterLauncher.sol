// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
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
/// @notice Top-level entry point. Owns the season state machine, per-wallet launch caps, and
///         the address of the singleton `IFilterFactory`. Also creates each season's
///         `SeasonVault`. Phase transitions are oracle-gated.
contract FilterLauncher is IFilterLauncher, Ownable2Step, Pausable {
    error WrongPhase();
    error LaunchCapReached();
    error NotOracle();
    error UnknownToken();
    error SeasonAlreadyOpen();

    event SeasonStarted(uint256 indexed seasonId, address vault);
    event TokenLaunched(
        uint256 indexed seasonId,
        address indexed token,
        address indexed locker,
        address creator,
        bool isProtocolLaunched,
        string name,
        string symbol,
        string metadataURI
    );
    event PhaseAdvanced(uint256 indexed seasonId, Phase newPhase);
    event FinalistsSet(uint256 indexed seasonId, address[] finalists);
    event WinnerSet(uint256 indexed seasonId, address winner);

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

    uint256 public override currentSeasonId;
    mapping(uint256 => Phase) internal _phase;
    mapping(uint256 => address) internal _vault;
    mapping(uint256 => address[]) internal _tokens;
    mapping(uint256 => mapping(address => TokenEntry)) internal _entry;
    mapping(uint256 => mapping(address => uint256)) public launchesByWallet;

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

    // ============================================================ Season lifecycle

    /// @notice Opens a new season. Deploys its `SeasonVault`. Must be called between seasons.
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
        emit SeasonStarted(seasonId, address(v));
    }

    function advancePhase(uint256 seasonId, Phase target) external onlyOracle whenNotPaused {
        Phase cur = _phase[seasonId];
        // Allow only forward, ordered transitions.
        require(uint8(target) == uint8(cur) + 1, "bad transition");
        _phase[seasonId] = target;
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

    function launch(string calldata name_, string calldata symbol_, string calldata metadataURI_)
        external
        whenNotPaused
        returns (address token, address locker)
    {
        if (_phase[currentSeasonId] != Phase.Launch) revert WrongPhase();
        if (launchesByWallet[currentSeasonId][msg.sender] >= maxLaunchesPerWallet) revert LaunchCapReached();
        ++launchesByWallet[currentSeasonId][msg.sender];
        (token, locker,) = _launch(name_, symbol_, metadataURI_, msg.sender, false);
    }

    /// @notice Owner-only path for $FILTER and any other protocol-launched seed tokens. Bypasses
    ///         the per-wallet cap; otherwise identical to `launch`.
    function launchProtocolToken(string calldata name_, string calldata symbol_, string calldata metadataURI_)
        external
        onlyOwner
        whenNotPaused
        returns (address token, address locker)
    {
        if (_phase[currentSeasonId] != Phase.Launch) revert WrongPhase();
        (token, locker,) = _launch(name_, symbol_, metadataURI_, msg.sender, true);
    }

    function _launch(
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
                seasonVault: _vault[currentSeasonId],
                treasury: treasury,
                mechanics: mechanics
            })
        );
        _entry[currentSeasonId][token] = TokenEntry({
            token: token,
            pool: address(0), // V4 pools are keyed, no address; left zero for compatibility
            feeSplitter: locker,
            creator: creator,
            isProtocolLaunched: isProtocolLaunched,
            isFinalist: false
        });
        _tokens[currentSeasonId].push(token);

        // Register (token, creator, launchedAt) and the seasonId mapping the distributor
        // uses for its own auth checks. Both contracts revert on duplicate token, so any
        // future token-deployment path that reuses the same address is rejected here too.
        creatorRegistry.register(token, creator);
        creatorFeeDistributor.registerToken(token, currentSeasonId);

        emit TokenLaunched(
            currentSeasonId, token, locker, creator, isProtocolLaunched, name_, symbol_, metadataURI_
        );
    }

    // ============================================================ Views

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
