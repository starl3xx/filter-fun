// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title FilterHook
/// @notice Singleton V4 hook used by every filter.fun pool. Gates liquidity modifications to a
///         pre-registered authority per pool — the factory authorizes itself (for initial seed)
///         and the per-token `FilterLpLocker` (for fee collection, liquidation, and rebuys).
///         Swaps are unrestricted (anyone can trade); the static fee is configured in `PoolKey.fee`.
contract FilterHook is IHooks {
    error UnauthorizedLiquidityModifier();
    error AuthorityAlreadySet();
    error NotFactory();

    address public immutable factory;

    /// @dev poolId => allowed liquidity modifier. The factory registers the locker right after
    ///      the initial liquidity seed; from then on only the locker may add or remove liquidity.
    mapping(PoolId => address) public authority;

    constructor(address factory_) {
        factory = factory_;
        Hooks.validateHookPermissions(
            IHooks(this),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: true,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    /// @notice Called by `FilterFactory` to hand off liquidity authority to the per-token locker.
    function setAuthority(PoolId id, address newAuthority) external {
        if (msg.sender != factory) revert NotFactory();
        if (authority[id] != address(0)) revert AuthorityAlreadySet();
        authority[id] = newAuthority;
    }

    function _check(PoolKey calldata key, address sender) internal view {
        address allowed = authority[key.toId()];
        // During the very first add-liquidity (initial seed) authority is unset; the factory is
        // the modifier in that one transaction.
        if (allowed == address(0)) {
            if (sender != factory) revert UnauthorizedLiquidityModifier();
        } else if (sender != allowed) {
            revert UnauthorizedLiquidityModifier();
        }
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external view returns (bytes4) {
        _check(key, sender);
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external view returns (bytes4) {
        _check(key, sender);
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        return (IHooks.afterSwap.selector, 0);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IHooks.afterDonate.selector;
    }
}
