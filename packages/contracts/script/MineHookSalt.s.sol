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
///         IMPORTANT — CREATE2 deployer:
///         Under `vm.startBroadcast()`, Foundry routes `new Contract{salt: ...}()` through
///         the canonical Deterministic Deployer Proxy at
///         `0x4e59b44847b379578588920ca78fbf26c0b4956c`, NOT the broadcasting EOA. So the
///         salt has to be mined against the DDP, not the operator's address. Mining against
///         the EOA produces a salt that lands at a different address at broadcast time and
///         the deploy reverts on the hook flag-bit check.
///
///         (The integration tests use `address(this)` because they construct the hook
///         directly without broadcast; that's the single-process path, deployer == caller.)
///
///         Usage:
///             forge script script/MineHookSalt.s.sol -vv
///
///         Output: copy `HOOK_SALT` into the env that runs `DeployGenesis`. The salt is
///         determined by `(creationCode, deployer=DDP)` only, so it's stable across machines
///         and reproducible — no per-operator mining.
contract MineHookSalt is Script {
    /// @dev Foundry's canonical CREATE2 factory. All `vm.broadcast`'d CREATE2 deployments go
    ///      through this address as the on-chain caller, regardless of the EOA broadcasting.
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external view {
        bytes memory creationCode = type(FilterHook).creationCode;
        (address hookAddress, bytes32 salt) =
            HookMiner.find(DETERMINISTIC_DEPLOYER, uint160(0xA00), creationCode);

        console2.log("CREATE2 deployer:", DETERMINISTIC_DEPLOYER);
        console2.log("Hook addr:       ", hookAddress);
        console2.log("Flag bits:       ", uint160(hookAddress) & 0x3FFF);
        console2.logBytes32(salt);
        console2.log(unicode"--- export HOOK_SALT=<bytes32 above> for DeployGenesis ↑ ---");
    }
}
