// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {FilterToken} from "./FilterToken.sol";
import {FilterHook} from "./FilterHook.sol";
import {FilterLpLocker, ICreatorFeeDistributor} from "./FilterLpLocker.sol";
import {CreatorCommitments} from "./CreatorCommitments.sol";
import {IFilterFactory} from "./interfaces/IFilterFactory.sol";

/// @title FilterFactory
/// @notice Single-tx deployer: ERC-20 → V4 pool init → per-token `FilterLpLocker` → seed LP
///         (the locker calls `PoolManager.unlock` so the position is owned by the locker, which
///         is what makes settlement-time liquidation work).
contract FilterFactory is IFilterFactory {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    error NotLauncher();

    IPoolManager public immutable poolManager;
    FilterHook public immutable hook;
    address public immutable launcher;
    address public immutable weth;
    /// @notice Singleton creator-fee sink. Wired immutably so every per-token locker the
    ///         factory deploys forwards its 0.20% creator slice to the same contract.
    address public immutable creatorFeeDistributor;
    /// @notice Singleton POL orchestrator. Wired immutably so every per-token locker can be
    ///         authorized to add POL liquidity at settlement.
    address public immutable polManager;
    /// @notice Singleton bag-lock primitive. Threaded into every `FilterToken` constructor as
    ///         an immutable reference so the token's transfer hook can consult the lock state
    ///         without per-call SLOAD-then-SSTORE indirection. A new commitments contract
    ///         requires a new factory + new tokens (by design — see `CreatorCommitments`).
    CreatorCommitments public immutable creatorCommitments;

    uint24 public constant FEE = 10_000; // 1.00%
    int24 public constant TICK_SPACING = 200;
    int24 public constant MAX_USABLE_TICK = 887_200;
    int24 public constant MIN_USABLE_TICK = -887_200;

    /// @dev Pool starts well outside the LP range so the seeded position is single-sided in
    ///      the launched token. Buyers swap base→token, pulling price into the range.
    int24 public constant INITIAL_TICK_TOKEN0 = -180_000;
    int24 public constant INITIAL_TICK_TOKEN1 = 180_000;
    int24 public constant LP_TICK_LOWER_TOKEN0 = -179_800;
    int24 public constant LP_TICK_UPPER_TOKEN0 = MAX_USABLE_TICK;
    int24 public constant LP_TICK_LOWER_TOKEN1 = MIN_USABLE_TICK;
    int24 public constant LP_TICK_UPPER_TOKEN1 = 179_800;

    uint256 public constant DEFAULT_INITIAL_SUPPLY = 1_000_000_000 ether;

    event TokenDeployed(address indexed token, address indexed locker, PoolId poolId, address creator);

    constructor(
        IPoolManager poolManager_,
        FilterHook hook_,
        address launcher_,
        address weth_,
        address creatorFeeDistributor_,
        address polManager_,
        CreatorCommitments creatorCommitments_
    ) {
        poolManager = poolManager_;
        hook = hook_;
        launcher = launcher_;
        weth = weth_;
        creatorFeeDistributor = creatorFeeDistributor_;
        polManager = polManager_;
        creatorCommitments = creatorCommitments_;
    }

    function deployToken(IFilterFactory.DeployArgs calldata args)
        external
        override
        returns (address token, address locker, PoolKey memory key)
    {
        if (msg.sender != launcher) revert NotLauncher();

        // 1. Deploy token (full supply minted to factory). Pass the bag-lock primitive so
        //    every transfer on this token consults the singleton commitments contract.
        bytes32 salt = keccak256(abi.encodePacked(args.creator, args.symbol, block.number));
        FilterToken t = new FilterToken{salt: salt}(
            args.name,
            args.symbol,
            DEFAULT_INITIAL_SUPPLY,
            address(this),
            args.metadataURI,
            creatorCommitments
        );
        token = address(t);

        // 2. Build pool key with proper currency ordering.
        bool tokenIsZero = token < weth;
        Currency c0 = Currency.wrap(tokenIsZero ? token : weth);
        Currency c1 = Currency.wrap(tokenIsZero ? weth : token);
        key = PoolKey({
            currency0: c0, currency1: c1, fee: FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))
        });

        // 3. Initialize pool at the chosen single-sided start price.
        int24 currentTick = tokenIsZero ? INITIAL_TICK_TOKEN0 : INITIAL_TICK_TOKEN1;
        int24 tickLower = tokenIsZero ? LP_TICK_LOWER_TOKEN0 : LP_TICK_LOWER_TOKEN1;
        int24 tickUpper = tokenIsZero ? LP_TICK_UPPER_TOKEN0 : LP_TICK_UPPER_TOKEN1;
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(currentTick);
        poolManager.initialize(key, sqrtPriceX96);

        // 4. Compute liquidity from the token-side seed (single-sided position).
        uint160 sqrtLowerX96 = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpperX96 = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity = tokenIsZero
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLowerX96, sqrtUpperX96, DEFAULT_INITIAL_SUPPLY)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLowerX96, sqrtUpperX96, DEFAULT_INITIAL_SUPPLY);

        // 5. Deploy locker.
        FilterLpLocker l = new FilterLpLocker(
            poolManager,
            address(this),
            args.seasonVault,
            token,
            weth,
            args.treasury,
            args.mechanics,
            ICreatorFeeDistributor(creatorFeeDistributor),
            polManager,
            key,
            tickLower,
            tickUpper,
            bytes32(0)
        );
        locker = address(l);

        // 6. Hand the freshly minted token supply to the locker (it'll consume them in seed()).
        IERC20(token).safeTransfer(locker, DEFAULT_INITIAL_SUPPLY);

        // 7. Authorize the locker on the hook BEFORE it tries to add liquidity.
        hook.setAuthority(key.toId(), locker);

        // 8. Locker seeds the position (owned by the locker — critical for settlement).
        l.seed(liquidity);

        emit TokenDeployed(token, locker, key.toId(), args.creator);
    }
}
