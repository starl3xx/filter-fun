// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICreatorFeeDistributor} from "../../src/SeasonVault.sol";

/// @notice No-op stand-in for the creator-fee distributor. `markFiltered` is just a counter so
///         tests can assert it was called for a given token; no auth.
contract MockCreatorFeeDistributor is ICreatorFeeDistributor {
    mapping(address => uint256) public markFilteredCount;

    function markFiltered(address token) external override {
        markFilteredCount[token] += 1;
    }
}
