// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title TreasuryTimelock
/// @notice Holds the protocol's 20% treasury cut. 48-hour delay on outflows. Boring on purpose.
contract TreasuryTimelock is TimelockController {
    constructor(address[] memory proposers, address[] memory executors, address admin)
        TimelockController(48 hours, proposers, executors, admin)
    {}
}
