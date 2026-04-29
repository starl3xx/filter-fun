// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ILpLocker} from "./interfaces/ILpLocker.sol";

interface ICreatorFeeDistributor {
    function notifyFee(address token, uint256 amount) external;
}

/// @title FilterLpLocker
/// @notice One per filter.fun-launched token. Permanently holds the V4 full-range LP position.
///         Splits collected fees per BPS, and exposes settlement primitives the season's vault
///         calls during week-end unwinding.
///
///         Trading fee = 2% of swap volume = 200 BPS, broken down on the WETH-side leg as:
///         - 0.90% → prize pool (seasonVault)        PRIZE_FEE_BPS = 90
///         - 0.65% → treasury                        TREASURY_FEE_BPS = 65
///         - 0.25% → mechanics                       MECHANICS_FEE_BPS = 25
///         - 0.20% → creator fee distributor         CREATOR_FEE_BPS = 20
///         Sum = 200 BPS by construction (see compile-time check below).
///
///         The token-leg fee dust is routed entirely to the season vault — it's negligible
///         in $ terms and doesn't merit a creator/treasury slice on every swap.
///
///         Liquidation is single-pool by design: the pool is the only source of liquidity
///         for the launched token, so we cannot swap loser-tokens to base after removal.
///         Instead, we extract the base-asset leg of the LP. The token leg is left in this
///         contract as effectively worthless dust.
contract FilterLpLocker is ILpLocker, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    // -------- Fee split policy. Constants are in basis points of total trade volume; sum
    //          must equal `FEE_TOTAL_BPS` (= 200 BPS = 2%) so the math reads as "x BPS of
    //          the trade goes to recipient y". A constructor invariant enforces the sum.
    uint256 internal constant FEE_TOTAL_BPS = 200;
    uint256 public constant PRIZE_FEE_BPS = 90;
    uint256 public constant TREASURY_FEE_BPS = 65;
    uint256 public constant MECHANICS_FEE_BPS = 25;
    uint256 public constant CREATOR_FEE_BPS = 20;

    // -------- Action codes for unlockCallback dispatch
    uint8 internal constant ACTION_COLLECT = 1;
    uint8 internal constant ACTION_LIQUIDATE = 2;
    uint8 internal constant ACTION_BUY = 3;
    uint8 internal constant ACTION_SEED = 4;
    uint8 internal constant ACTION_POL_ADD = 5;

    /// @notice Salt distinguishing the POL position from the seed position. Both live in the
    ///         same V4 pool with the same tick range — the salt is what separates them in
    ///         position-key space. Seed uses bytes32(0); POL uses bytes32(uint256(1)).
    bytes32 public constant POL_SALT = bytes32(uint256(1));

    // -------- Immutable wiring
    IPoolManager public immutable poolManager;
    address public immutable factory;
    address public immutable vault;
    address public immutable override token;
    address public immutable override baseAsset; // WETH
    address public immutable treasury;
    address public immutable mechanics;
    ICreatorFeeDistributor public immutable creatorFeeDistributor;
    /// @notice Singleton POL orchestrator. Authorized to call `addPolLiquidity` so the POL
    ///         system can deposit a permanent LP position alongside the seed.
    address public immutable polManager;
    bool public immutable tokenIsCurrency0;
    PoolKey internal _key;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    bytes32 public immutable positionSalt;

    // -------- Mutable state
    bool public override liquidated;

    // -------- Events / errors
    event FeesCollected(
        uint256 toVault, uint256 toTreasury, uint256 toMechanics, uint256 toCreator, address asset
    );
    event LiquidatedToBase(uint256 baseRecovered, uint256 tokenStranded);
    event Bought(uint256 wethIn, uint256 tokensOut);
    event PolLiquidityAdded(uint256 wethIn, uint256 wethUsed, uint256 tokensUsed, uint128 liquidity);

    error NotPoolManager();
    error NotVault();
    error NotFactory();
    error NotPolManager();
    error AlreadyLiquidated();
    error AlreadySeeded();
    error InsufficientOutput();
    error UnknownAction();

    bool public seeded;

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    modifier onlyManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        address factory_,
        address vault_,
        address token_,
        address baseAsset_,
        address treasury_,
        address mechanics_,
        ICreatorFeeDistributor creatorFeeDistributor_,
        address polManager_,
        PoolKey memory key_,
        int24 tickLower_,
        int24 tickUpper_,
        bytes32 positionSalt_
    ) {
        // Invariant: BPS slices must sum to FEE_TOTAL_BPS so the WETH split is exact.
        require(
            PRIZE_FEE_BPS + TREASURY_FEE_BPS + MECHANICS_FEE_BPS + CREATOR_FEE_BPS == FEE_TOTAL_BPS, "fee bps"
        );
        poolManager = poolManager_;
        factory = factory_;
        vault = vault_;
        token = token_;
        baseAsset = baseAsset_;
        treasury = treasury_;
        mechanics = mechanics_;
        creatorFeeDistributor = creatorFeeDistributor_;
        polManager = polManager_;
        _key = key_;
        tickLower = tickLower_;
        tickUpper = tickUpper_;
        positionSalt = positionSalt_;
        tokenIsCurrency0 = Currency.unwrap(key_.currency0) == token_;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    // ============================================================ Public actions

    /// @notice Factory-only. Adds the initial liquidity owned by THIS locker contract using the
    ///         token balance the factory has just transferred in.
    function seed(uint128 liquidity) external nonReentrant {
        if (msg.sender != factory) revert NotFactory();
        if (seeded) revert AlreadySeeded();
        seeded = true;
        bytes memory data = abi.encode(ACTION_SEED, uint256(liquidity), address(0), uint256(0));
        poolManager.unlock(data);
    }

    function collectFees() external override nonReentrant {
        bytes memory data = abi.encode(ACTION_COLLECT, uint256(0), address(0), uint256(0));
        poolManager.unlock(data);
    }

    function liquidateToWETH(address recipient, uint256 minOutWETH)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 wethOut)
    {
        if (liquidated) revert AlreadyLiquidated();
        liquidated = true;
        bytes memory data = abi.encode(ACTION_LIQUIDATE, uint256(0), recipient, minOutWETH);
        bytes memory ret = poolManager.unlock(data);
        wethOut = abi.decode(ret, (uint256));
        if (wethOut < minOutWETH) revert InsufficientOutput();
    }

    function buyTokenWithWETH(uint256 wethIn, address recipient, uint256 minOutTokens)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 tokensOut)
    {
        IERC20(baseAsset).safeTransferFrom(msg.sender, address(this), wethIn);
        bytes memory data = abi.encode(ACTION_BUY, wethIn, recipient, minOutTokens);
        bytes memory ret = poolManager.unlock(data);
        tokensOut = abi.decode(ret, (uint256));
        if (tokensOut < minOutTokens) revert InsufficientOutput();
    }

    /// @notice Add a permanent POL position alongside the seed. Caller (POLManager) hands over
    ///         `wethIn` WETH; we swap half to tokens through this same pool, then add liquidity
    ///         at the current tick range with both legs. The resulting position is keyed by
    ///         `POL_SALT` so it doesn't collide with the seed.
    ///
    ///         `minTokensFromSwap` is the slippage guard on the swap leg — the WETH→token swap
    ///         is the only sandwich-able step (LP adds at a manipulated price still produce a
    ///         valid position, just at a worse ratio, but the swap loss is real WETH gone). The
    ///         oracle computes a TWAP-based floor and passes it through; we revert if the swap
    ///         output undercuts it. `_doPolAdd` performs the check inside the unlock callback.
    ///
    ///         Returns the (wethUsed, tokensUsed, liquidity) actually deposited so POLManager
    ///         can record it on POLVault. Any rounding dust on either side stays in this locker.
    function addPolLiquidity(uint256 wethIn, uint256 minTokensFromSwap)
        external
        nonReentrant
        returns (uint256 wethUsed, uint256 tokensUsed, uint128 liquidity)
    {
        if (msg.sender != polManager) revert NotPolManager();
        IERC20(baseAsset).safeTransferFrom(msg.sender, address(this), wethIn);
        bytes memory data = abi.encode(ACTION_POL_ADD, wethIn, address(0), minTokensFromSwap);
        bytes memory ret = poolManager.unlock(data);
        (wethUsed, tokensUsed, liquidity) = abi.decode(ret, (uint256, uint256, uint128));
    }

    // ============================================================ Unlock callback

    function unlockCallback(bytes calldata data) external override onlyManager returns (bytes memory) {
        (uint8 action, uint256 amountIn, address recipient, uint256 minOut) =
            abi.decode(data, (uint8, uint256, address, uint256));

        if (action == ACTION_COLLECT) {
            _doCollect();
            return "";
        } else if (action == ACTION_LIQUIDATE) {
            uint256 out = _doLiquidate(recipient);
            return abi.encode(out);
        } else if (action == ACTION_BUY) {
            uint256 out = _doBuy(amountIn, recipient, minOut);
            return abi.encode(out);
        } else if (action == ACTION_SEED) {
            _doSeed(uint128(amountIn));
            return "";
        } else if (action == ACTION_POL_ADD) {
            (uint256 wethUsed, uint256 tokensUsed, uint128 liquidity) = _doPolAdd(amountIn, minOut);
            return abi.encode(wethUsed, tokensUsed, liquidity);
        } else {
            revert UnknownAction();
        }
    }

    // ============================================================ Internal action handlers

    function _doSeed(uint128 liquidity) internal {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: positionSalt
            }),
            ""
        );
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 < 0) _settleERC20(_key.currency0, uint256(uint128(-a0)));
        if (a1 < 0) _settleERC20(_key.currency1, uint256(uint128(-a1)));
    }

    function _settleERC20(Currency currency, uint256 amount) internal {
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }

    function _doCollect() internal {
        // Poke the position with zero liquidity delta to accrue + materialize fees.
        (, BalanceDelta feesAccrued) = poolManager.modifyLiquidity(
            _key,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 0, salt: positionSalt
            }),
            ""
        );
        int128 fee0 = feesAccrued.amount0();
        int128 fee1 = feesAccrued.amount1();
        if (fee0 > 0) _takeAndSplit(_key.currency0, uint256(uint128(fee0)));
        if (fee1 > 0) _takeAndSplit(_key.currency1, uint256(uint128(fee1)));
    }

    function _doLiquidate(address recipient) internal returns (uint256 baseOut) {
        PoolId pid = _key.toId();
        bytes32 positionId = keccak256(abi.encodePacked(address(this), tickLower, tickUpper, positionSalt));
        uint128 liq = poolManager.getPositionLiquidity(pid, positionId);

        BalanceDelta delta;
        if (liq > 0) {
            (delta,) = poolManager.modifyLiquidity(
                _key,
                ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: -int256(uint256(liq)),
                    salt: positionSalt
                }),
                ""
            );
        }

        int128 amt0 = delta.amount0();
        int128 amt1 = delta.amount1();

        bool baseIsZero = baseAsset == Currency.unwrap(_key.currency0);
        int128 baseAmt = baseIsZero ? amt0 : amt1;
        int128 tokenAmt = baseIsZero ? amt1 : amt0;

        if (baseAmt > 0) {
            baseOut = uint256(uint128(baseAmt));
            poolManager.take(Currency.wrap(baseAsset), recipient, baseOut);
        }
        if (tokenAmt > 0) {
            // Token leg is dust once the pool's only liquidity is gone — take to self.
            poolManager.take(Currency.wrap(token), address(this), uint256(uint128(tokenAmt)));
        }
        emit LiquidatedToBase(baseOut, tokenAmt > 0 ? uint256(uint128(tokenAmt)) : 0);
    }

    function _doBuy(
        uint256 wethIn,
        address recipient,
        uint256 /* minOut */
    )
        internal
        returns (uint256 tokensOut)
    {
        bool zeroForOne = !tokenIsCurrency0; // base → token
        Currency inputCurrency = zeroForOne ? _key.currency0 : _key.currency1;
        Currency outputCurrency = zeroForOne ? _key.currency1 : _key.currency0;

        BalanceDelta delta = poolManager.swap(
            _key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(wethIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Settle input owed: sync, transfer, settle.
        poolManager.sync(inputCurrency);
        IERC20(Currency.unwrap(inputCurrency)).safeTransfer(address(poolManager), wethIn);
        poolManager.settle();

        int128 outAmt = zeroForOne ? delta.amount1() : delta.amount0();
        require(outAmt > 0, "no output");
        tokensOut = uint256(uint128(outAmt));
        poolManager.take(outputCurrency, recipient, tokensOut);
        emit Bought(wethIn, tokensOut);
    }

    /// @dev Inside the unlock callback: swap half the WETH to tokens through this same pool,
    ///      then add a position keyed by `POL_SALT` at the existing tick range with both legs.
    ///      `minTokensFromSwap` is the oracle-supplied slippage floor — we revert if the swap
    ///      undercuts it (sandwich defense for a publicly-visible `submitWinner` tx).
    ///      Settles WETH (transfer in) and token (take from pool) deltas to zero. Any rounding
    ///      dust on either side stays in this contract.
    function _doPolAdd(uint256 wethIn, uint256 minTokensFromSwap)
        internal
        returns (uint256 wethUsed, uint256 tokensUsed, uint128 liquidity)
    {
        // 1. Swap half the WETH to tokens through this same V4 pool.
        uint256 swapAmount = wethIn / 2;
        bool zeroForOne = !tokenIsCurrency0; // base → token
        Currency inputCurrency = zeroForOne ? _key.currency0 : _key.currency1;
        Currency outputCurrency = zeroForOne ? _key.currency1 : _key.currency0;
        BalanceDelta swapDelta = poolManager.swap(
            _key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(swapAmount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 outAmt = zeroForOne ? swapDelta.amount1() : swapDelta.amount0();
        require(outAmt > 0, "no output");
        uint256 tokensReceived = uint256(uint128(outAmt));
        if (tokensReceived < minTokensFromSwap) revert InsufficientOutput();

        // 2. Compute liquidity for the LP add. Both halves of the WETH are now claimable —
        //    swapAmount as input to the swap (we owe to pool) and wethIn - swapAmount that
        //    will go into the position.
        uint256 wethForLp = wethIn - swapAmount;
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(_key.toId());
        uint160 sqrtLowerX96 = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpperX96 = TickMath.getSqrtPriceAtTick(tickUpper);
        uint256 amount0 = tokenIsCurrency0 ? tokensReceived : wethForLp;
        uint256 amount1 = tokenIsCurrency0 ? wethForLp : tokensReceived;
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, sqrtLowerX96, sqrtUpperX96, amount0, amount1
        );

        // 3. Add the position keyed by POL_SALT.
        (BalanceDelta addDelta,) = poolManager.modifyLiquidity(
            _key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: POL_SALT
            }),
            ""
        );

        // 4. Settle deltas. After swap+add the locker owes WETH (input + LP add) and may be
        //    owed leftover token dust if the LP add consumed less than `tokensReceived`.
        int128 a0 = swapDelta.amount0() + addDelta.amount0();
        int128 a1 = swapDelta.amount1() + addDelta.amount1();
        if (a0 < 0) _settleERC20(_key.currency0, uint256(uint128(-a0)));
        if (a1 < 0) _settleERC20(_key.currency1, uint256(uint128(-a1)));
        if (a0 > 0) poolManager.take(_key.currency0, address(this), uint256(uint128(a0)));
        if (a1 > 0) poolManager.take(_key.currency1, address(this), uint256(uint128(a1)));

        // The LP-add legs (positive = locker owes, taken from `addDelta` which has both negative
        // for an add). For the indexer-friendly emit, report what the position consumed.
        int128 add0 = addDelta.amount0();
        int128 add1 = addDelta.amount1();
        // Adds have negative deltas; |add| is what the position consumed.
        uint256 added0 = add0 < 0 ? uint256(uint128(-add0)) : 0;
        uint256 added1 = add1 < 0 ? uint256(uint128(-add1)) : 0;
        if (tokenIsCurrency0) {
            tokensUsed = added0;
            wethUsed = added1;
        } else {
            tokensUsed = added1;
            wethUsed = added0;
        }
        emit PolLiquidityAdded(wethIn, wethUsed, tokensUsed, liquidity);
        // Suppress unused-var warning for `outputCurrency` when neither branch uses it directly.
        outputCurrency;
    }

    /// @notice Liquidity of the POL position currently held by this locker.
    function polLiquidity() external view returns (uint128) {
        bytes32 positionId = keccak256(abi.encodePacked(address(this), tickLower, tickUpper, POL_SALT));
        return poolManager.getPositionLiquidity(_key.toId(), positionId);
    }

    function _takeAndSplit(Currency currency, uint256 amount) internal {
        if (amount == 0) return;
        // Token-leg fee dust → vault. Splitting per-BPS across four recipients on the
        // token-side adds bookkeeping for negligible value (the fee is denominated in the
        // launched-token, which has no external market until a winner is picked).
        if (Currency.unwrap(currency) != baseAsset) {
            poolManager.take(currency, vault, amount);
            emit FeesCollected(amount, 0, 0, 0, Currency.unwrap(currency));
            return;
        }
        // WETH-leg: 4-way split per the user-aligned BPS. Vault takes whatever rounding
        // dust falls out of the integer math so the fixed slices (treasury, mechanics,
        // creator) are exact.
        uint256 toTreasury = (amount * TREASURY_FEE_BPS) / FEE_TOTAL_BPS;
        uint256 toMechanics = (amount * MECHANICS_FEE_BPS) / FEE_TOTAL_BPS;
        uint256 toCreator = (amount * CREATOR_FEE_BPS) / FEE_TOTAL_BPS;
        uint256 toVault = amount - toTreasury - toMechanics - toCreator;
        poolManager.take(currency, vault, toVault);
        poolManager.take(currency, treasury, toTreasury);
        poolManager.take(currency, mechanics, toMechanics);
        if (toCreator > 0) {
            poolManager.take(currency, address(creatorFeeDistributor), toCreator);
            // Notify is separate from `take` so the distributor can verify the WETH
            // actually arrived (vs. trusting a bookkeeping-only call); see notifyFee.
            creatorFeeDistributor.notifyFee(token, toCreator);
        }
        emit FeesCollected(toVault, toTreasury, toMechanics, toCreator, Currency.unwrap(currency));
    }
}
