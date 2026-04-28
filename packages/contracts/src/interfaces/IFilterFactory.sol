// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";

interface IFilterFactory {
    struct DeployArgs {
        string name;
        string symbol;
        string metadataURI;
        address creator;
        address seasonVault;
        address treasury;
        address mechanics;
    }

    function deployToken(DeployArgs calldata args)
        external
        returns (address token, address locker, PoolKey memory key);
}
