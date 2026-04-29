// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title POLVault
/// @notice Singleton accounting + visibility layer for protocol-owned-liquidity positions across
///         all seasons. The actual LP positions are owned by the per-token `FilterLpLocker`
///         contracts (same locker that holds the seed) — this contract holds NO tokens; it just
///         records the (winner, weth, tokens, liquidity) tuples each `POLManager.deployPOL` call
///         materialized, so the indexer + broadcast UI can surface per-token, per-season, and
///         total-protocol POL exposure.
///
///         Why no tokens here? V4 positions are non-transferable and live wherever they were
///         minted from. The locker is already the natural owner — it's also the contract that
///         can liquidate or interact with the position via its action dispatch. Splitting the
///         records from the holdings is a pure SoC win: this vault is read-mostly and never
///         needs reentrancy guards or token-handling code.
///
///         POL is *intentionally* permanent in this iteration. The LP stays in the locker
///         forever; there is no withdraw path. A future iteration can add yield routing or
///         mechanics-funding withdrawal under a hard cap (`MAX_MECHANICS_BPS`), but that's
///         deliberately out of scope today.
///
///         Auth model:
///         - Only the registered `POLManager` may call `recordDeployment` (set once via
///           `setPolManager`). The launcher's registered SeasonVault is the only caller of
///           `POLManager.deployPOL`, so the chain of trust runs vault → manager → here.
///         - Owner is the deployer multisig; `transferOwnership` is Ownable2Step (multisig must
///           call `acceptOwnership` to take control).
contract POLVault is Ownable2Step {
    /// @notice One canonical record per (seasonId) — there's exactly one POL deployment per
    ///         season, at `submitWinner` time. The struct captures everything the UI needs:
    ///         the winner token, the WETH originally deployed (for "total protocol POL" reads),
    ///         the tokens that ended up paired in the LP, the V4 liquidity units, and a
    ///         timestamp.
    struct Deployment {
        address winner;
        uint256 wethDeployed;
        uint256 tokensDeployed;
        uint128 liquidity;
        uint64 deployedAt;
    }

    /// @notice POLManager wired post-deploy via `setPolManager`. Once set, immutable.
    ///         This breaks the constructor-ordering chicken-and-egg with FilterLauncher
    ///         (POLManager wants the launcher; the launcher wants POLVault).
    address public polManager;

    /// @notice Per-season deployment record. Zero-initialized for seasons that haven't
    ///         finalized yet (or finalized with zero POL — `recorded[seasonId]` distinguishes).
    mapping(uint256 => Deployment) internal _seasons;
    mapping(uint256 => bool) public recorded;

    /// @notice All seasons that have recorded a deployment, in deploy order. Lets the UI list
    ///         positions without scanning a sparse `seasonId` keyspace.
    uint256[] internal _seasonList;

    /// @notice Cumulative WETH ever deployed into POL across the protocol's lifetime. Sum of
    ///         every `Deployment.wethDeployed` ever recorded.
    uint256 public totalWethDeployed;
    /// @notice Cumulative LP units (V4 liquidity) across all seasons. Useful as a coarse
    ///         "total POL position size" metric independent of token price.
    uint256 public totalLiquidity;

    /// @notice Per-winner-token aggregations. The same token *could* in principle win multiple
    ///         seasons (we don't filter past winners from re-launching as new contracts, but
    ///         the same address winning twice would be unusual); these mappings let the UI
    ///         answer "how much protocol exposure exists in token X?" in O(1).
    mapping(address => uint256) public tokenWethDeployed;
    mapping(address => uint128) public tokenLiquidity;

    event PolManagerSet(address indexed polManager);
    event DeploymentRecorded(
        uint256 indexed seasonId,
        address indexed winner,
        uint256 wethDeployed,
        uint256 tokensDeployed,
        uint128 liquidity
    );

    error PolManagerAlreadySet();
    error PolManagerNotSet();
    error NotPolManager();
    error AlreadyRecorded();
    error ZeroAddress();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice One-shot wire of the POLManager. Owner-only; reverts if already set or zero.
    function setPolManager(address polManager_) external onlyOwner {
        if (polManager != address(0)) revert PolManagerAlreadySet();
        if (polManager_ == address(0)) revert ZeroAddress();
        polManager = polManager_;
        emit PolManagerSet(polManager_);
    }

    /// @notice POLManager-only. Records the result of a `POLManager.deployPOL` call. Idempotent
    ///         per season — reverts on duplicate so a misbehaving manager can't overwrite a
    ///         canonical record.
    function recordDeployment(
        uint256 seasonId,
        address winner,
        uint256 wethDeployed,
        uint256 tokensDeployed,
        uint128 liquidity
    ) external {
        address pm = polManager;
        if (pm == address(0)) revert PolManagerNotSet();
        if (msg.sender != pm) revert NotPolManager();
        if (recorded[seasonId]) revert AlreadyRecorded();

        recorded[seasonId] = true;
        _seasons[seasonId] = Deployment({
            winner: winner,
            wethDeployed: wethDeployed,
            tokensDeployed: tokensDeployed,
            liquidity: liquidity,
            deployedAt: uint64(block.timestamp)
        });
        _seasonList.push(seasonId);
        totalWethDeployed += wethDeployed;
        totalLiquidity += liquidity;
        tokenWethDeployed[winner] += wethDeployed;
        tokenLiquidity[winner] += liquidity;

        emit DeploymentRecorded(seasonId, winner, wethDeployed, tokensDeployed, liquidity);
    }

    // ============================================================ Views

    /// @notice Per-season deployment record. Returns zero-initialized struct for unrecorded
    ///         seasons; pair with `recorded[seasonId]` to disambiguate.
    function deploymentOf(uint256 seasonId) external view returns (Deployment memory) {
        return _seasons[seasonId];
    }

    /// @notice List of all season IDs that have recorded a POL deployment, in chronological
    ///         order. Returned as a copy — for an indexed UI, prefer subscribing to the
    ///         `DeploymentRecorded` event.
    function getSeasonList() external view returns (uint256[] memory) {
        return _seasonList;
    }

    /// @notice Number of POL deployments recorded across the protocol's lifetime.
    function deploymentCount() external view returns (uint256) {
        return _seasonList.length;
    }

    /// @notice Total WETH originally deployed into protocol-owned LP positions across all
    ///         seasons. The headline "total POL" number for the broadcast UI.
    function getTotalPOLValue() external view returns (uint256) {
        return totalWethDeployed;
    }

    /// @notice Per-token POL exposure (in original-WETH terms). Sum of all season deployments
    ///         where the same token won. Zero for tokens that never won a season.
    function getTokenPOLValue(address token) external view returns (uint256) {
        return tokenWethDeployed[token];
    }

    /// @notice Snapshot of all recorded LP positions, in deploy order. Convenience accessor for
    ///         the UI; for many seasons prefer subscribing to events.
    function getLPPositions() external view returns (Deployment[] memory positions) {
        uint256 n = _seasonList.length;
        positions = new Deployment[](n);
        for (uint256 i = 0; i < n; ++i) {
            positions[i] = _seasons[_seasonList[i]];
        }
    }
}
