// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICreatorRegistry} from "../../src/SeasonVault.sol";

/// @notice No-op stand-in for the singleton (token → creator) registry. Lets unit tests set
///         the creator for any token without going through the launcher's launch path.
contract MockCreatorRegistry is ICreatorRegistry {
    mapping(address => address) public override creatorOf;

    function set(address token, address creator) external {
        creatorOf[token] = creator;
    }
}
