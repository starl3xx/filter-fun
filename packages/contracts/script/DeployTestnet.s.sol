// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {ManifestWriter} from "./ManifestWriter.sol";
import {ScriptUtils} from "./ScriptUtils.sol";
import {FilterLauncher} from "../src/FilterLauncher.sol";
import {FilterClubPass} from "../src/FilterClubPass.sol";
import {FilterFactory} from "../src/FilterFactory.sol";
import {FilterHook} from "../src/FilterHook.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {POLVault} from "../src/POLVault.sol";
import {POLManager, IPOLVaultRecord} from "../src/POLManager.sol";
import {IBonusFunding, IPOLManager} from "../src/SeasonVault.sol";
import {IFilterFactory} from "../src/interfaces/IFilterFactory.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";
import {TournamentRegistry} from "../src/TournamentRegistry.sol";
import {TournamentVault, ITournamentRegistryView, ICreatorRegistryView} from "../src/TournamentVault.sol";

/// @notice Testnet deploy (Robinhood Chain testnet 46630 — the rehearsal target since the
///         2026-07 retarget — or Base Sepolia 84532 as the retreat path). Deploys the full
///         filter.fun contract suite against the configured Uniswap V4 PoolManager, then
///         writes a manifest at `deployments/<network-slug>.json` (slug from
///         `ScriptUtils.networkSlugForChain`) that the indexer + web read for addresses.
///
///         Robinhood testnet has NO canonical Uniswap v4 or WETH9 — run
///         `DeployTestnetInfra.s.sol` first and feed its printed addresses into
///         `V4_POOL_MANAGER_ADDRESS` / `WETH_ADDRESS`.
///
///         Differences from `DeployGenesis` (mainnet):
///           - EOA treasury / oracle / pol-vault-owner are tolerated (single key OK on testnet).
///           - Mines the FilterHook CREATE2 salt inline if `HOOK_SALT` isn't in env, and writes
///             it back into the manifest so re-runs (after `rm`-ing the manifest) read the
///             cached salt instead of re-mining.
///           - Calls `setRefundableStakeEnabled` with the env value so testnet config is
///             authoritative even when it matches contract defaults. (Per-wallet cap is
///             enforced structurally by LaunchEscrow per spec §46 — no env knob.)
///           - Refuses to overwrite an existing manifest unless `FORCE_REDEPLOY=1`. Re-runs
///             without that flag bail with a clear error so the operator can `rm` first.
///
///         Required env:
///           DEPLOYER_PRIVATE_KEY         deployer EOA (also accepted as PRIVATE_KEY)
///           V4_POOL_MANAGER_ADDRESS      V4 PoolManager on the target testnet
///           WETH_ADDRESS                 WETH9 on the target testnet
///           TREASURY_OWNER               EOA acting as treasury timelock admin + recipient
///           SCHEDULER_ORACLE_ADDRESS     scheduler oracle EOA (calls startSeason/cuts/etc.)
///           REFUNDABLE_STAKE_ENABLED     "true" or "false"
///         (legacy MAX_LAUNCHES_PER_WALLET env var is accepted but ignored — the
///          structural per-wallet cap of 1 lives in LaunchEscrow now per spec §46)
///
///         Optional env (default to TREASURY_OWNER):
///           MECHANICS_WALLET             events/missions wallet
///           POL_VAULT_OWNER              POLVault owner (Ownable2Step accept handled off-band)
///
///         Optional:
///           HOOK_SALT                    pre-mined CREATE2 salt; mined inline if absent
///           DEPLOY_COMMIT_HASH           git rev for the manifest (set by wrapper script)
///           FORCE_REDEPLOY               "1" to overwrite an existing manifest
///           FILTER_CLUB_SUPPLY           FilterClubPass max supply (default 250)
///           FILTER_CLUB_PRICE            FilterClubPass mint price in wei (default 0.05 ether)
///           FILTER_CLUB_WALLET_CAP       FilterClubPass per-wallet mint cap (default 5)
///           FILTER_CLUB_BASE_URI         FilterClubPass metadata root (default filter.fun API)
///           FILTER_CLUB_PAYOUT           mint-proceeds recipient (default: the TreasuryTimelock)
contract DeployTestnet is Script, ManifestWriter {
    /// Foundry's canonical CREATE2 factory — `vm.broadcast` routes `new C{salt: ...}()` here.
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// Hook flag bits for FilterHook (BEFORE_ADD_LIQUIDITY | BEFORE_REMOVE_LIQUIDITY).
    uint160 internal constant HOOK_FLAGS = uint160(0xA00);

    function run() external {
        string memory manifestPath = ScriptUtils.manifestPath();

        // ------------------------------------------------------------ Idempotency check
        bool force = ScriptUtils.envBool("FORCE_REDEPLOY", false);
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
        uint256 pk = ScriptUtils.envPrivateKey();
        address pmAddr = vm.envAddress("V4_POOL_MANAGER_ADDRESS");
        address weth = vm.envAddress("WETH_ADDRESS");
        address treasuryOwner = vm.envAddress("TREASURY_OWNER");
        address oracle = vm.envAddress("SCHEDULER_ORACLE_ADDRESS");
        address mechanics = vm.envOr("MECHANICS_WALLET", treasuryOwner);
        address polVaultOwner = vm.envOr("POL_VAULT_OWNER", treasuryOwner);
        // Spec §46 deferred-activation: the launcher enforces the per-wallet cap
        // structurally via LaunchEscrow (1 reservation per wallet per season). The legacy
        // MAX_LAUNCHES_PER_WALLET env var is no longer read by the contract; it remains
        // accepted-and-ignored for one release so any cached deploy script doesn't break.
        bool refundableStake = ScriptUtils.envBool("REFUNDABLE_STAKE_ENABLED", true);

        require(
            block.chainid == 46_630 || block.chainid == 84_532,
            "DeployTestnet: unsupported testnet chainid (want 46630 Robinhood testnet or 84532 Base Sepolia)"
        );

        address deployer = vm.addr(pk);
        console2.log("=== DeployTestnet ===");
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

        // 3b. FilterClubPass — founding-member lifetime pass (Epic 2.6). Deployed BEFORE
        //     the launcher because the launcher takes it as an immutable constructor arg;
        //     the pass learns the launcher via its own one-shot `setLauncher` below.
        //     Mint proceeds default to the TreasuryTimelock (open `receive()`).
        uint256 clubMaxSupply = vm.envOr("FILTER_CLUB_SUPPLY", uint256(250));
        uint256 clubMintPrice = vm.envOr("FILTER_CLUB_PRICE", uint256(0.05 ether));
        uint32 clubWalletCap = uint32(vm.envOr("FILTER_CLUB_WALLET_CAP", uint256(5)));
        string memory clubBaseURI =
            vm.envOr("FILTER_CLUB_BASE_URI", string("https://filter.fun/api/club/meta/"));
        address clubPayout = vm.envOr("FILTER_CLUB_PAYOUT", address(treasury));
        FilterClubPass clubPass = new FilterClubPass(
            deployer, clubPayout, clubBaseURI, clubMaxSupply, clubMintPrice, clubWalletCap
        );
        console2.log("FilterClubPass:      ", address(clubPass));

        // 4. FilterLauncher — inline-deploys CreatorRegistry, CreatorFeeDistributor,
        //    CreatorCommitments, LaunchEscrow, LauncherLens, LauncherStakeAdmin. Their
        //    addresses are pulled below for the manifest; we don't construct them
        //    separately. TournamentRegistry + TournamentVault are deployed externally
        //    (their init code pushes the launcher past EIP-3860 when inlined) and wired
        //    via the one-shot `wire` below (with factory + POLManager).
        FilterLauncher launcher = new FilterLauncher(
            deployer, oracle, address(treasury), mechanics, IBonusFunding(address(bonus)), weth, clubPass
        );
        console2.log("FilterLauncher:      ", address(launcher));
        clubPass.setLauncher(address(launcher));

        // 4b. Tournament contracts — externalised post-§46 to fit EIP-3860. Deployed with
        //     the launcher's address as `launcher_`, then wired via `wire` below.
        TournamentRegistry tournamentRegistry = new TournamentRegistry(address(launcher));
        TournamentVault tournamentVault = new TournamentVault(
            address(launcher),
            weth,
            address(treasury),
            mechanics,
            ITournamentRegistryView(address(tournamentRegistry)),
            ICreatorRegistryView(address(launcher.creatorRegistry())),
            launcher.bonusUnlockDelay()
        );
        console2.log("TournamentRegistry:  ", address(tournamentRegistry));
        console2.log("TournamentVault:     ", address(tournamentVault));

        // 5. POLManager — wants the launcher's address in its constructor, so we deploy it
        //    after the launcher; the launcher side lands in the `wire` call below.
        POLManager polManager = new POLManager(address(launcher), weth, IPOLVaultRecord(address(polVault)));
        console2.log("POLManager:          ", address(polManager));
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
            address(polManager),
            launcher.creatorCommitments()
        );
        console2.log("FilterFactory:       ", address(factory));

        hook.initialize(address(factory));
        // One-shot atomic wire of every externally-deployed dependency (Epic 2.6 —
        // replaces setFactory / setPolManager / setTournament). All four exist by here.
        launcher.wire(
            IFilterFactory(address(factory)),
            IPOLManager(address(polManager)),
            tournamentRegistry,
            tournamentVault
        );

        // 7. Sepolia-specific config knobs. Per-wallet cap is no longer configurable —
        //    LaunchEscrow enforces 1 reservation per wallet per season structurally
        //    (spec §46). Set the refundable-stake toggle (the base cost stays at the
        //    launcher's default 0.05 ether).
        launcher.setLaunchConfig(launcher.baseLaunchCost(), refundableStake);

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
                clubPass: address(clubPass),
                clubMintPrice: clubMintPrice,
                clubMaxSupply: clubMaxSupply,
                launcher: address(launcher),
                launchEscrow: address(launcher.launchEscrow()),
                launcherStakeAdmin: address(launcher.stakeAdmin()),
                polManager: address(polManager),
                hook: address(hook),
                factory: address(factory),
                creatorRegistry: address(launcher.creatorRegistry()),
                creatorFeeDistributor: address(launcher.creatorFeeDistributor()),
                creatorCommitments: address(launcher.creatorCommitments()),
                tournamentRegistry: address(launcher.tournamentRegistry()),
                tournamentVault: address(launcher.tournamentVault()),
                v4PoolManager: pmAddr,
                weth: weth,
                treasuryOwner: treasuryOwner,
                oracle: oracle,
                mechanics: mechanics,
                polVaultOwner: polVaultOwner,
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
}
