// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {FilterHook} from "../src/FilterHook.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice Convenience wrapper around `HookMiner.find` so operators can mine the FilterHook
///         CREATE2 salt without writing a one-shot script. V4 routes hook calls based on the
///         lower-14-bit pattern of the hook address, so for `FilterHook` the deployment must
///         land at an address satisfying `addr & 0x3FFF == 0xA00` (BEFORE_ADD_LIQUIDITY |
///         BEFORE_REMOVE_LIQUIDITY).
///
///         Usage:
///             DEPLOYER=0x... forge script script/MineHookSalt.s.sol -vv
///
///         Output: copy `HOOK_SALT` and `HOOK_ADDRESS` into the env you'll pass to
///         `DeployGenesis`. Salt is determined by deployer + creation-code, so re-running
///         locally with the same DEPLOYER yields the same salt deterministically.
contract MineHookSalt is Script {
    function run() external view {
        address deployer = vm.envAddress("DEPLOYER");

        bytes memory creationCode = type(FilterHook).creationCode;
        (address hookAddress, bytes32 salt) = HookMiner.find(deployer, uint160(0xA00), creationCode);

        console2.log("Deployer:    ", deployer);
        console2.log("Hook addr:   ", hookAddress);
        console2.log("Flag bits:   ", uint160(hookAddress) & 0x3FFF);
        console2.logBytes32(salt);
        console2.log(unicode"--- export this into the env that runs DeployGenesis ↑ ---");
    }
}
