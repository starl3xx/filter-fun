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
import {TournamentRegistry} from "../src/TournamentRegistry.sol";
import {TournamentVault, ITournamentRegistryView, ICreatorRegistryView} from "../src/TournamentVault.sol";

/// @notice Bootstraps filter.fun on Robinhood Chain mainnet (4663 — the genesis target
///         since the 2026-07 retarget). Reads addresses + signers from env and writes the
///         deploy manifest (`deployments/robinhood.json`) that the indexer + web consume.
///
///         Required env:
///         - PRIVATE_KEY               deployer EOA
///         - WETH_ADDRESS              WETH ERC-20 address on the target chain
///                                     (mainnet 4663: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
///                                      legacy name BASE_WETH accepted for one release)
///         - V4_POOL_MANAGER           Uniswap V4 PoolManager address on the target chain
///                                     (mainnet 4663: 0x8366a39cc670b4001a1121b8f6a443a643e40951)
///         - ORACLE_MULTISIG           oracle signer (EOA at launch per 2026-07-09 ops
///                                     decision; rotate to Safe once verified on-chain)
///         - TREASURY_PROPOSER_0..2    treasury timelock proposer signers (may repeat one EOA)
///         - MECHANICS_WALLET          events/missions wallet
///         - POL_VAULT_OWNER           owner of the POLVault (escape hatch)
///
///         Optional env: FILTER_CLUB_* (see DeployTestnet header), DEPLOY_COMMIT_HASH,
///         FORCE_REDEPLOY, ALLOW_TESTNET_GENESIS (permits chainid 46630 for the
///         unmodified-bytecode rehearsal smoke deploy — see docs/runbook-robinhood-deploy.md).
///
///         NOTE on the hook: `FilterHook` must be deployed at an address whose lower 14 bits
///         encode the BEFORE_ADD_LIQUIDITY (1<<11) and BEFORE_REMOVE_LIQUIDITY (1<<9) flags
///         (0xA00). This script does NOT mine that salt — run `script/MineHookSalt.s.sol`
///         first and export the printed `HOOK_SALT` into the env that drives this script.
contract DeployGenesis is Script, ManifestWriter {
    function run() external {
        // Chain gate (mirrors DeployTestnet's — added when the testnet gate's absence here
        // was flagged in the retarget review). 46630 is allowed ONLY behind an explicit
        // env acknowledgment, for the rehearsal's mainnet-bytecode smoke deploy.
        require(
            block.chainid == 4663
                || (block.chainid == 46_630 && ScriptUtils.envBool("ALLOW_TESTNET_GENESIS", false)),
            "DeployGenesis: chainId != 4663 (Robinhood Chain); set ALLOW_TESTNET_GENESIS=1 for a 46630 smoke deploy"
        );

        string memory manifestPath = ScriptUtils.manifestPath();
        // Idempotency: refuse to overwrite a real prior deploy (same guard as DeployTestnet).
        if (vm.exists(manifestPath) && !ScriptUtils.envBool("FORCE_REDEPLOY", false)) {
            try vm.parseJsonAddress(vm.readFile(manifestPath), ".addresses.filterLauncher") returns (
                address prior
            ) {
                if (prior != address(0)) {
                    console2.log("Refusing to redeploy. Existing manifest at:", manifestPath);
                    console2.log("  prior FilterLauncher:", prior);
                    revert("manifest exists; set FORCE_REDEPLOY=1 to overwrite");
                }
            } catch {}
        }

        uint256 pk = vm.envUint("PRIVATE_KEY");
        // WETH_ADDRESS is the canonical name (matches DeployTestnet); BASE_WETH is the
        // pre-retarget legacy name, accepted for one release.
        address weth = vm.envOr("WETH_ADDRESS", address(0));
        if (weth == address(0)) weth = vm.envAddress("BASE_WETH");
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

        // 3. POLVault — singleton accounting layer for protocol-owned LP positions. Deployed
        //    with the deployer as initial owner so we can call `setPolManager` before handing
        //    ownership to the multisig.
        POLVault polVault = new POLVault(deployer);
        console2.log("POLVault:", address(polVault));

        // 3b. FilterClubPass — founding-member lifetime pass (Epic 2.6). Deployed BEFORE the
        //     launcher because the launcher takes it as an immutable constructor arg; the pass
        //     learns the launcher via its own one-shot `setLauncher` below. Mint proceeds
        //     default to the TreasuryTimelock (open `receive()`).
        uint256 clubMaxSupply = vm.envOr("FILTER_CLUB_SUPPLY", uint256(250));
        uint256 clubMintPrice = vm.envOr("FILTER_CLUB_PRICE", uint256(0.05 ether));
        uint32 clubWalletCap = uint32(vm.envOr("FILTER_CLUB_WALLET_CAP", uint256(5)));
        string memory clubBaseURI =
            vm.envOr("FILTER_CLUB_BASE_URI", string("https://filter.fun/api/club/meta/"));
        address clubPayout = vm.envOr("FILTER_CLUB_PAYOUT", address(treasury));
        FilterClubPass clubPass = new FilterClubPass(
            deployer, clubPayout, clubBaseURI, clubMaxSupply, clubMintPrice, clubWalletCap
        );
        console2.log("FilterClubPass:", address(clubPass));

        // 4. FilterLauncher. POLManager is wired post-construction (chicken-and-egg: POLManager
        //    wants the launcher's address).
        FilterLauncher launcher = new FilterLauncher(
            deployer, oracle, address(treasury), mechanics, IBonusFunding(address(bonus)), weth, clubPass
        );
        console2.log("FilterLauncher:", address(launcher));
        clubPass.setLauncher(address(launcher));

        // 5. POLManager — orchestrator that turns the season's POL WETH into a permanent V4 LP
        //    position on the winner pool, then records on POLVault for indexer/UI visibility.
        POLManager polManager = new POLManager(address(launcher), weth, IPOLVaultRecord(address(polVault)));
        console2.log("POLManager:", address(polManager));

        // 6. Wire POLManager into POLVault (one-shot setter). The launcher side lands in the
        //    atomic `wire` call below (step 10).
        polVault.setPolManager(address(polManager));

        // 6b. Tournament contracts — externalised post-§46 to fit EIP-3860. Deploy with the
        //     launcher's address as `launcher_`, then wire via `wire` below (step 10).
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
        console2.log("TournamentRegistry:", address(tournamentRegistry));
        console2.log("TournamentVault:", address(tournamentVault));

        // 7. FilterHook (deterministic via CREATE2 salt to satisfy hook flag bits).
        //    Constructor takes no args — factory is wired post-construction via initialize().
        FilterHook hook = new FilterHook{salt: hookSalt}();
        console2.log("FilterHook:", address(hook));

        // 8. FilterFactory wires hook + manager + launcher + weth + polManager + commitments.
        FilterFactory factory = new FilterFactory(
            IPoolManager(pmAddr),
            hook,
            address(launcher),
            weth,
            address(launcher.creatorFeeDistributor()),
            address(polManager),
            launcher.creatorCommitments()
        );
        console2.log("FilterFactory:", address(factory));

        // 9. Initialize hook with factory address (one-shot).
        hook.initialize(address(factory));

        // 10. One-shot atomic wire of every externally-deployed dependency (Epic 2.6 —
        //     replaces setFactory / setPolManager / setTournament).
        launcher.wire(
            IFilterFactory(address(factory)),
            IPOLManager(address(polManager)),
            tournamentRegistry,
            tournamentVault
        );

        // 11. Hand POLVault ownership to the multisig (Ownable2Step — multisig must accept).
        polVault.transferOwnership(polVaultOwner);

        // 12. Open Season 1.
        // Note: launcher's startSeason is onlyOracle; the deployer is the OWNER (Ownable),
        // so this call must be done by the oracle signer in a follow-up tx after deployment.

        vm.stopBroadcast();

        // 13. Manifest — same writer as DeployTestnet (the indexer + web read this file on
        //     every network; genesis previously wrote nothing, which left both consumers on
        //     env-var fallbacks).
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
                tournamentRegistry: address(tournamentRegistry),
                tournamentVault: address(tournamentVault),
                v4PoolManager: pmAddr,
                weth: weth,
                treasuryOwner: deployer,
                oracle: oracle,
                mechanics: mechanics,
                polVaultOwner: polVaultOwner,
                refundableStake: launcher.refundableStakeEnabled()
            })
        );
        console2.log("Manifest written:", manifestPath);

        console2.log("=== Deploy complete ===");
        console2.log("Next steps (oracle signer):");
        console2.log("  1. polVault.acceptOwnership() (from POL_VAULT_OWNER)");
        console2.log("  2. launcher.startSeason()");
        console2.log("  3. forge script LaunchFilterToken --rpc-url $RPC --broadcast");
    }
}
