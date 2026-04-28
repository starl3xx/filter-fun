// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {FilterToken} from "./FilterToken.sol";
import {FilterHook} from "./FilterHook.sol";
import {FilterLpLocker} from "./FilterLpLocker.sol";
import {IFilterFactory} from "./interfaces/IFilterFactory.sol";

/// @title FilterFactory
/// @notice Single-tx deployer: ERC-20 → V4 pool init → seed full-range LP → per-token
///         `FilterLpLocker`. The pool is initialized at a price near the boundary that puts
///         the entire seed on the token side (effectively single-sided), so no base seed is
///         required from the launcher.
contract FilterFactory is IUnlockCallback, IFilterFactory {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    error NotLauncher();
    error NotPoolManager();

    IPoolManager public immutable poolManager;
    FilterHook public immutable hook;
    address public immutable launcher;
    address public immutable usdc;

    uint24 public constant FEE = 10_000; // 1.00%
    int24 public constant TICK_SPACING = 200;
    int24 public constant MAX_USABLE_TICK = 887_200;
    int24 public constant MIN_USABLE_TICK = -887_200;

    uint256 public constant DEFAULT_INITIAL_SUPPLY = 1_000_000_000 ether;

    event TokenDeployed(address indexed token, address indexed locker, PoolId poolId, address creator);

    struct CallbackData {
        address token;
        bool tokenIsZero;
        PoolKey key;
        uint128 liquidity;
    }

    constructor(IPoolManager poolManager_, FilterHook hook_, address launcher_, address usdc_) {
        poolManager = poolManager_;
        hook = hook_;
        launcher = launcher_;
        usdc = usdc_;
    }

    function deployToken(IFilterFactory.DeployArgs calldata args)
        external
        override
        returns (address token, address locker, PoolKey memory key)
    {
        if (msg.sender != launcher) revert NotLauncher();

        bytes32 salt = keccak256(abi.encodePacked(args.creator, args.symbol, block.number));
        FilterToken t = new FilterToken{salt: salt}(
            args.name, args.symbol, DEFAULT_INITIAL_SUPPLY, address(this), args.metadataURI
        );
        token = address(t);

        bool tokenIsZero = token < usdc;
        Currency c0 = Currency.wrap(tokenIsZero ? token : usdc);
        Currency c1 = Currency.wrap(tokenIsZero ? usdc : token);
        key = PoolKey({
            currency0: c0, currency1: c1, fee: FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))
        });

        // Initialize at a price near the boundary that yields a single-sided token-only seed:
        // - if token is currency0, start at MIN tick (price → 0): token0 dominates
        // - if token is currency1, start at MAX tick (price → ∞): token1 dominates
        int24 startTick = tokenIsZero ? MIN_USABLE_TICK : MAX_USABLE_TICK;
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(startTick);
        poolManager.initialize(key, sqrtPriceX96);

        // Compute liquidity from the token-side amount (full range).
        uint160 sqrtPriceLowerX96 = TickMath.getSqrtPriceAtTick(MIN_USABLE_TICK);
        uint160 sqrtPriceUpperX96 = TickMath.getSqrtPriceAtTick(MAX_USABLE_TICK);
        uint128 liquidity = tokenIsZero
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtPriceX96, sqrtPriceUpperX96, DEFAULT_INITIAL_SUPPLY)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtPriceLowerX96, sqrtPriceX96, DEFAULT_INITIAL_SUPPLY);

        bytes memory cbData = abi.encode(
            CallbackData({token: token, tokenIsZero: tokenIsZero, key: key, liquidity: liquidity})
        );
        poolManager.unlock(cbData);

        // Deploy locker, then transfer liquidity authority to it.
        FilterLpLocker l = new FilterLpLocker(
            poolManager,
            address(this),
            args.seasonVault,
            token,
            usdc,
            args.treasury,
            args.mechanics,
            key,
            MIN_USABLE_TICK,
            MAX_USABLE_TICK,
            bytes32(0)
        );
        locker = address(l);
        hook.setAuthority(key.toId(), locker);

        emit TokenDeployed(token, locker, key.toId(), args.creator);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory d = abi.decode(data, (CallbackData));

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            d.key,
            ModifyLiquidityParams({
                tickLower: MIN_USABLE_TICK,
                tickUpper: MAX_USABLE_TICK,
                liquidityDelta: int256(uint256(d.liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Settle whichever side(s) we owe.
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();

        if (a0 < 0) _settleERC20(d.key.currency0, uint256(uint128(-a0)));
        if (a1 < 0) _settleERC20(d.key.currency1, uint256(uint128(-a1)));

        return "";
    }

    function _settleERC20(Currency currency, uint256 amount) internal {
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }
}
