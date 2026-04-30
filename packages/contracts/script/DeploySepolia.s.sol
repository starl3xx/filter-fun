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
import {POLManager, IPOLVaultRecord} from "../src/POLManager.sol";
import {IBonusFunding, IPOLManager} from "../src/SeasonVault.sol";
import {IFilterFactory} from "../src/interfaces/IFilterFactory.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice Base Sepolia deploy. Deploys the full filter.fun contract suite against the
///         canonical Uniswap V4 PoolManager on chain 84532, then writes a manifest at
///         `deployments/base-sepolia.json` that the indexer + web read for addresses.
///
///         Differences from `DeployGenesis` (mainnet):
///           - EOA treasury / oracle / pol-vault-owner are tolerated (single key OK on Sepolia).
///           - Mines the FilterHook CREATE2 salt inline if `HOOK_SALT` isn't in env, and writes
///             it back into the manifest so re-runs (after `rm`-ing the manifest) read the
///             cached salt instead of re-mining.
///           - Calls `setMaxLaunchesPerWallet` + `setRefundableStakeEnabled` with env values,
///             so Sepolia config is authoritative even when it matches contract defaults.
///           - Refuses to overwrite an existing manifest unless `FORCE_REDEPLOY=1`. Re-runs
///             without that flag bail with a clear error so the operator can `rm` first.
///
///         Required env:
///           DEPLOYER_PRIVATE_KEY         deployer EOA (also accepted as PRIVATE_KEY)
///           V4_POOL_MANAGER_ADDRESS      canonical V4 PoolManager on Base Sepolia
///           WETH_ADDRESS                 canonical WETH9 on Base Sepolia
///           TREASURY_OWNER               EOA acting as treasury timelock admin + recipient
///           SCHEDULER_ORACLE_ADDRESS     scheduler oracle EOA (calls startSeason/cuts/etc.)
///           MAX_LAUNCHES_PER_WALLET      cap (Sepolia: 1)
///           REFUNDABLE_STAKE_ENABLED     "true" or "false"
///
///         Optional env (default to TREASURY_OWNER):
///           MECHANICS_WALLET             events/missions wallet
///           POL_VAULT_OWNER              POLVault owner (Ownable2Step accept handled off-band)
///
///         Optional:
///           HOOK_SALT                    pre-mined CREATE2 salt; mined inline if absent
///           DEPLOY_COMMIT_HASH           git rev for the manifest (set by wrapper script)
///           FORCE_REDEPLOY               "1" to overwrite an existing manifest
contract DeploySepolia is Script {
    /// Foundry's canonical CREATE2 factory — `vm.broadcast` routes `new C{salt: ...}()` here.
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// Hook flag bits for FilterHook (BEFORE_ADD_LIQUIDITY | BEFORE_REMOVE_LIQUIDITY).
    uint160 internal constant HOOK_FLAGS = uint160(0xA00);

    /// Where the manifest lands. Resolved against `forge`'s working dir, which is the
    /// `packages/contracts/` package root. The `deployments/` directory is committed (via
    /// .gitkeep) so this file shows up alongside the other build artifacts. Tests override
    /// this via `MANIFEST_PATH_OVERRIDE` to avoid clobbering a real manifest.
    string internal constant DEFAULT_MANIFEST_PATH = "./deployments/base-sepolia.json";

    function run() external {
        string memory manifestPath = _manifestPath();

        // ------------------------------------------------------------ Idempotency check
        bool force = _envBool("FORCE_REDEPLOY", false);
        if (vm.exists(manifestPath) && !force) {
            string memory existing = vm.readFile(manifestPath);
            // A manifest with a non-zero `addresses.filterLauncher` means a real prior deploy.
            // Bail loudly so we don't accidentally re-broadcast and orphan the prior contracts.
            try vm.parseJsonAddress(existing, ".addresses.filterLauncher") returns (address prior) {
                if (prior != address(0)) {
                    console2.log("Refusing to redeploy. Existing manifest at:", manifestPath);
                    console2.log("  prior FilterLauncher:", prior);
                    console2.log("  set FORCE_REDEPLOY=1 to overwrite (or `rm` the manifest).");
                    revert("manifest exists; set FORCE_REDEPLOY=1 to overwrite");
                }
            } catch {
                // Manifest exists but has no launcher address yet — treat as a partial run,
                // safe to overwrite.
            }
        }

        // ------------------------------------------------------------ Read env
        uint256 pk = _envPrivateKey();
        address pmAddr = vm.envAddress("V4_POOL_MANAGER_ADDRESS");
        address weth = vm.envAddress("WETH_ADDRESS");
        address treasuryOwner = vm.envAddress("TREASURY_OWNER");
        address oracle = vm.envAddress("SCHEDULER_ORACLE_ADDRESS");
        address mechanics = vm.envOr("MECHANICS_WALLET", treasuryOwner);
        address polVaultOwner = vm.envOr("POL_VAULT_OWNER", treasuryOwner);
        uint256 maxLaunchesPerWallet = vm.envUint("MAX_LAUNCHES_PER_WALLET");
        bool refundableStake = _envBool("REFUNDABLE_STAKE_ENABLED", true);

        require(block.chainid == 84_532, "DeploySepolia: chainId != 84532 (Base Sepolia)");

        address deployer = vm.addr(pk);
        console2.log("=== DeploySepolia ===");
        console2.log("chainId:        ", block.chainid);
        console2.log("deployer:       ", deployer);
        console2.log("v4 poolManager: ", pmAddr);
        console2.log("WETH:           ", weth);
        console2.log("treasury owner: ", treasuryOwner);
        console2.log("oracle:         ", oracle);

        // ------------------------------------------------------------ Hook salt
        bytes32 hookSalt = _readOrMineHookSalt();

        // ------------------------------------------------------------ Deploy
        vm.startBroadcast(pk);

        // 1. TreasuryTimelock — single-proposer EOA pattern is fine for Sepolia.
        address[] memory proposers = new address[](1);
        proposers[0] = treasuryOwner;
        TreasuryTimelock treasury = new TreasuryTimelock(proposers, proposers, treasuryOwner);
        console2.log("TreasuryTimelock:    ", address(treasury));

        // 2. BonusDistributor — launcher addr is immutable in the constructor, so we wire to
        //    `deployer` for genesis and rotate via redeploy if needed (see DeployGenesis note).
        BonusDistributor bonus = new BonusDistributor(deployer, weth, oracle);
        console2.log("BonusDistributor:    ", address(bonus));

        // 3. POLVault — singleton accounting layer for protocol-owned LP.
        POLVault polVault = new POLVault(deployer);
        console2.log("POLVault:            ", address(polVault));

        // 4. FilterLauncher — inline-deploys CreatorRegistry, CreatorFeeDistributor,
        //    TournamentRegistry, TournamentVault. Their addresses are pulled below for the
        //    manifest; we don't construct them separately.
        FilterLauncher launcher = new FilterLauncher(
            deployer, oracle, address(treasury), mechanics, IBonusFunding(address(bonus)), weth
        );
        console2.log("FilterLauncher:      ", address(launcher));

        // 5. POLManager — wants the launcher's address in its constructor, so we deploy it
        //    after the launcher and call `setPolManager` on both sides.
        POLManager polManager = new POLManager(address(launcher), weth, IPOLVaultRecord(address(polVault)));
        console2.log("POLManager:          ", address(polManager));
        launcher.setPolManager(IPOLManager(address(polManager)));
        polVault.setPolManager(address(polManager));

        // 6. FilterHook (deterministic via CREATE2 salt) → factory wires post-construct.
        FilterHook hook = new FilterHook{salt: hookSalt}();
        require(uint160(address(hook)) & 0x3FFF == HOOK_FLAGS, "hook flag bits mismatch");
        console2.log("FilterHook:          ", address(hook));

        FilterFactory factory = new FilterFactory(
            IPoolManager(pmAddr),
            hook,
            address(launcher),
            weth,
            address(launcher.creatorFeeDistributor()),
            address(polManager)
        );
        console2.log("FilterFactory:       ", address(factory));

        hook.initialize(address(factory));
        launcher.setFactory(IFilterFactory(address(factory)));

        // 7. Sepolia-specific config knobs.
        launcher.setMaxLaunchesPerWallet(maxLaunchesPerWallet);
        launcher.setRefundableStakeEnabled(refundableStake);

        // 8. Hand POLVault ownership to the configured owner. Ownable2Step — owner must
        //    `acceptOwnership()` separately. Skipped when polVaultOwner == deployer (no-op).
        if (polVaultOwner != deployer) {
            polVault.transferOwnership(polVaultOwner);
            console2.log("POLVault ownership pending accept by:", polVaultOwner);
        }

        vm.stopBroadcast();

        // ------------------------------------------------------------ Manifest
        _writeManifest(
            manifestPath,
            ManifestArgs({
                deployer: deployer,
                hookSalt: hookSalt,
                treasury: address(treasury),
                bonus: address(bonus),
                polVault: address(polVault),
                launcher: address(launcher),
                polManager: address(polManager),
                hook: address(hook),
                factory: address(factory),
                creatorRegistry: address(launcher.creatorRegistry()),
                creatorFeeDistributor: address(launcher.creatorFeeDistributor()),
                tournamentRegistry: address(launcher.tournamentRegistry()),
                tournamentVault: address(launcher.tournamentVault()),
                v4PoolManager: pmAddr,
                weth: weth,
                treasuryOwner: treasuryOwner,
                oracle: oracle,
                mechanics: mechanics,
                polVaultOwner: polVaultOwner,
                maxLaunchesPerWallet: maxLaunchesPerWallet,
                refundableStake: refundableStake
            })
        );

        console2.log("=== Deploy complete ===");
        console2.log("Manifest:", manifestPath);
        console2.log("Next steps:");
        console2.log("  1. forge verify-contract (handled by deploy-sepolia.sh)");
        if (polVaultOwner != deployer) {
            console2.log("  2. polVault.acceptOwnership() from POL_VAULT_OWNER");
        }
        console2.log("  3. oracle: launcher.startSeason()");
        console2.log("  4. forge script SeedFilter --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast");
    }

    // ============================================================ Helpers

    /// Manifest path with optional env override. Tests set `MANIFEST_PATH_OVERRIDE` to a tmp
    /// file so they don't clobber the real `./deployments/base-sepolia.json`.
    function _manifestPath() internal view returns (string memory) {
        try vm.envString("MANIFEST_PATH_OVERRIDE") returns (string memory v) {
            return bytes(v).length == 0 ? DEFAULT_MANIFEST_PATH : v;
        } catch {
            return DEFAULT_MANIFEST_PATH;
        }
    }

    /// Accept either `DEPLOYER_PRIVATE_KEY` (per spec) or `PRIVATE_KEY` (legacy convention).
    function _envPrivateKey() internal view returns (uint256) {
        try vm.envUint("DEPLOYER_PRIVATE_KEY") returns (uint256 pk) {
            return pk;
        } catch {
            return vm.envUint("PRIVATE_KEY");
        }
    }

    function _envBool(string memory key, bool fallback_) internal view returns (bool) {
        try vm.envString(key) returns (string memory raw) {
            if (bytes(raw).length == 0) return fallback_;
            // Whitelist truthy/falsy spellings explicitly. `vm.envBool`'s parser is forgiving
            // about spaces and casing in different forge versions; doing it ourselves keeps
            // the contract's behavior independent of forge-std version drift, which matters
            // because env state leaks across test files (process-wide) and a misparse would
            // silently bypass the FORCE_REDEPLOY guard.
            if (_eq(raw, "1") || _eq(raw, "true") || _eq(raw, "TRUE")) return true;
            if (_eq(raw, "0") || _eq(raw, "false") || _eq(raw, "FALSE")) return false;
            return fallback_;
        } catch {
            return fallback_;
        }
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// Use HOOK_SALT from env if set; else mine inline against the canonical DDP. Mining is
    /// deterministic over `(creationCode, deployer)` so the salt is stable across machines.
    /// Cost: ~few seconds for the 0xA00 flag pattern.
    function _readOrMineHookSalt() internal view returns (bytes32) {
        try vm.envBytes32("HOOK_SALT") returns (bytes32 salt) {
            console2.log("Using HOOK_SALT from env");
            console2.logBytes32(salt);
            return salt;
        } catch {
            console2.log("Mining HOOK_SALT (no env override)...");
            (address hookAddr, bytes32 salt) =
                HookMiner.find(DETERMINISTIC_DEPLOYER, HOOK_FLAGS, type(FilterHook).creationCode);
            console2.log("  mined hook addr:", hookAddr);
            console2.log("  mined salt:");
            console2.logBytes32(salt);
            return salt;
        }
    }

    /// Manifest write. Two sub-objects (`addresses` + `config`) plus top-level metadata.
    /// `filterToken` is left null — `SeedFilter.s.sol` populates it after the protocol launch.
    struct ManifestArgs {
        address deployer;
        bytes32 hookSalt;
        address treasury;
        address bonus;
        address polVault;
        address launcher;
        address polManager;
        address hook;
        address factory;
        address creatorRegistry;
        address creatorFeeDistributor;
        address tournamentRegistry;
        address tournamentVault;
        address v4PoolManager;
        address weth;
        address treasuryOwner;
        address oracle;
        address mechanics;
        address polVaultOwner;
        uint256 maxLaunchesPerWallet;
        bool refundableStake;
    }

    function _writeManifest(string memory path, ManifestArgs memory a) internal {
        // Foundry's JSON builder serializes by *key prefix*: each `vm.serializeX(prefix, ...)`
        // call appends to a json blob keyed under that prefix and returns the cumulative
        // string. Build the two sub-objects, then attach them to the root.
        string memory addrs = "addresses";
        vm.serializeAddress(addrs, "treasuryTimelock", a.treasury);
        vm.serializeAddress(addrs, "bonusDistributor", a.bonus);
        vm.serializeAddress(addrs, "polVault", a.polVault);
        vm.serializeAddress(addrs, "filterLauncher", a.launcher);
        vm.serializeAddress(addrs, "polManager", a.polManager);
        vm.serializeAddress(addrs, "filterHook", a.hook);
        vm.serializeAddress(addrs, "filterFactory", a.factory);
        vm.serializeAddress(addrs, "creatorRegistry", a.creatorRegistry);
        vm.serializeAddress(addrs, "creatorFeeDistributor", a.creatorFeeDistributor);
        vm.serializeAddress(addrs, "tournamentRegistry", a.tournamentRegistry);
        vm.serializeAddress(addrs, "tournamentVault", a.tournamentVault);
        vm.serializeAddress(addrs, "v4PoolManager", a.v4PoolManager);
        string memory addrsJson = vm.serializeAddress(addrs, "weth", a.weth);

        string memory cfg = "config";
        vm.serializeAddress(cfg, "treasuryOwner", a.treasuryOwner);
        vm.serializeAddress(cfg, "schedulerOracle", a.oracle);
        vm.serializeAddress(cfg, "mechanicsWallet", a.mechanics);
        vm.serializeAddress(cfg, "polVaultOwner", a.polVaultOwner);
        vm.serializeUint(cfg, "maxLaunchesPerWallet", a.maxLaunchesPerWallet);
        string memory cfgJson = vm.serializeBool(cfg, "refundableStakeEnabled", a.refundableStake);

        string memory root = "manifest";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "network", "base-sepolia");
        vm.serializeUint(root, "deployBlockNumber", block.number);
        vm.serializeUint(root, "deployedAt", block.timestamp);
        vm.serializeAddress(root, "deployerAddress", a.deployer);
        vm.serializeBytes32(root, "hookSalt", a.hookSalt);
        // `filterToken` placeholder — SeedFilter.s.sol writes the real value over this.
        vm.serializeString(root, "filterToken", "");
        vm.serializeString(
            root, "deployCommitHash", _envOrDefaultString("DEPLOY_COMMIT_HASH", "unknown")
        );
        vm.serializeString(root, "addresses", addrsJson);
        string memory finalJson = vm.serializeString(root, "config", cfgJson);

        vm.writeJson(finalJson, path);
    }

    function _envOrDefaultString(string memory key, string memory fallback_)
        internal
        view
        returns (string memory)
    {
        try vm.envString(key) returns (string memory v) {
            return bytes(v).length == 0 ? fallback_ : v;
        } catch {
            return fallback_;
        }
    }
}
