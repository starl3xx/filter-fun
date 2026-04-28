// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {FilterLauncher} from "../src/FilterLauncher.sol";

/// @notice Genesis Week 1 protocol-launch of $FILTER. Run by the deployer multisig after
///         `DeployGenesis` and after the oracle multisig has called `launcher.startSeason()`.
///
///         Required env:
///         - PRIVATE_KEY           deployer / launcher owner
///         - FILTER_LAUNCHER       FilterLauncher address from DeployGenesis output
///         - FILTER_METADATA_URI   ipfs:// URI for the $FILTER token metadata
contract LaunchFilterToken is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address launcherAddr = vm.envAddress("FILTER_LAUNCHER");
        string memory metadata = vm.envString("FILTER_METADATA_URI");

        FilterLauncher launcher = FilterLauncher(launcherAddr);

        vm.startBroadcast(pk);
        (address token, address locker) = launcher.launchProtocolToken("filter.fun", "FILTER", metadata);
        vm.stopBroadcast();

        console2.log("$FILTER token:", token);
        console2.log("$FILTER locker:", locker);
    }
}
