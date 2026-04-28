// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {MintableERC20} from "./MintableERC20.sol";
import {MockLpLocker} from "./MockLpLocker.sol";

contract MockFilterFactory is IFilterFactory {
    address public immutable launcher;
    address public immutable usdc;

    constructor(address launcher_, address usdc_) {
        launcher = launcher_;
        usdc = usdc_;
    }

    function deployToken(IFilterFactory.DeployArgs calldata args)
        external
        override
        returns (address token, address locker, PoolKey memory key)
    {
        require(msg.sender == launcher, "not launcher");
        MintableERC20 t = new MintableERC20(args.name, args.symbol);
        token = address(t);
        MockLpLocker l = new MockLpLocker(token, usdc, args.seasonVault);
        locker = address(l);
        key;
    }
}
