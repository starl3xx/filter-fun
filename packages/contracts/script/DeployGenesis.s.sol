// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {FilterLauncher} from "../src/FilterLauncher.sol";
import {FilterFactory} from "../src/FilterFactory.sol";
import {FilterHook} from "../src/FilterHook.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {POLVault} from "../src/POLVault.sol";
import {IBonusFunding} from "../src/SeasonVault.sol";
import {IFilterFactory} from "../src/interfaces/IFilterFactory.sol";

/// @notice Bootstraps filter.fun on Base. Reads addresses + multisig signers from env.
///
///         Required env:
///         - PRIVATE_KEY               deployer EOA
///         - BASE_WETH                 WETH ERC-20 address on the target chain
///         - V4_POOL_MANAGER           Uniswap V4 PoolManager address on the target chain
///         - ORACLE_MULTISIG           2-of-3 oracle Safe
///         - TREASURY_PROPOSER_0..2    treasury timelock proposer signers
///         - MECHANICS_WALLET          events/missions wallet
///         - POL_VAULT_OWNER           multisig that owns the POLVault (escape hatch)
///
///         NOTE on the hook: `FilterHook` must be deployed at an address whose lower 14 bits
///         encode the BEFORE_ADD_LIQUIDITY (1<<11) and BEFORE_REMOVE_LIQUIDITY (1<<9) flags
///         (0xA00). This script does NOT mine that salt — run `script/MineHookSalt.s.sol`
///         first and export the printed `HOOK_SALT` into the env that drives this script.
contract DeployGenesis is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address weth = vm.envAddress("BASE_WETH");
        address pmAddr = vm.envAddress("V4_POOL_MANAGER");
        address oracle = vm.envAddress("ORACLE_MULTISIG");
        address mechanics = vm.envAddress("MECHANICS_WALLET");
        address polVaultOwner = vm.envAddress("POL_VAULT_OWNER");
        bytes32 hookSalt = vm.envBytes32("HOOK_SALT");

        address[] memory proposers = new address[](3);
        proposers[0] = vm.envAddress("TREASURY_PROPOSER_0");
        proposers[1] = vm.envAddress("TREASURY_PROPOSER_1");
        proposers[2] = vm.envAddress("TREASURY_PROPOSER_2");

        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        // 1. TreasuryTimelock (admin = deployer for genesis; rotate post-deploy via timelock).
        TreasuryTimelock treasury = new TreasuryTimelock(proposers, proposers, deployer);
        console2.log("TreasuryTimelock:", address(treasury));

        // 2. BonusDistributor (launcher set later via setLauncher pattern -- not implemented;
        //    for genesis, BonusDistributor.launcher is immutable so we encode a placeholder
        //    and rotate by redeploy. Production: introduce setLauncher gated by previous launcher).
        BonusDistributor bonus = new BonusDistributor(deployer, weth, oracle);
        console2.log("BonusDistributor:", address(bonus));

        // 3. POLVault — singleton, holds protocol-owned exposure across all seasons. Deployed
        //    with the deployer as initial owner so we can call `setLauncher` before handing
        //    ownership to the multisig. The multisig runs the LP-add migration in a future
        //    iteration.
        POLVault polVault = new POLVault(deployer);
        console2.log("POLVault:", address(polVault));

        // 4. FilterLauncher.
        FilterLauncher launcher = new FilterLauncher(
            deployer,
            oracle,
            address(treasury),
            mechanics,
            address(polVault),
            IBonusFunding(address(bonus)),
            weth
        );
        console2.log("FilterLauncher:", address(launcher));

        // 5. Wire launcher into POLVault (one-shot; required for vault auth on deposit).
        polVault.setLauncher(address(launcher));

        // 6. FilterHook (deterministic via CREATE2 salt to satisfy hook flag bits).
        //    Constructor takes no args — factory is wired post-construction via initialize().
        FilterHook hook = new FilterHook{salt: hookSalt}();
        console2.log("FilterHook:", address(hook));

        // 7. FilterFactory wires hook + manager + launcher + weth.
        FilterFactory factory = new FilterFactory(IPoolManager(pmAddr), hook, address(launcher), weth);
        console2.log("FilterFactory:", address(factory));

        // 8. Initialize hook with factory address (one-shot).
        hook.initialize(address(factory));

        // 9. Wire factory into launcher.
        launcher.setFactory(IFilterFactory(address(factory)));

        // 10. Hand POLVault ownership to the multisig (Ownable2Step — multisig must accept).
        polVault.transferOwnership(polVaultOwner);

        // 11. Open Season 1.
        // Note: launcher's startSeason is onlyOracle; the deployer is the OWNER (Ownable),
        // so this call must be done by the oracle multisig in a follow-up tx after deployment.

        vm.stopBroadcast();

        console2.log("=== Deploy complete ===");
        console2.log("Next steps (oracle multisig):");
        console2.log("  1. polVault.acceptOwnership() (from POL_VAULT_OWNER multisig)");
        console2.log("  2. launcher.startSeason()");
        console2.log("  3. forge script LaunchFilterToken --rpc-url $RPC --broadcast");
    }
}
