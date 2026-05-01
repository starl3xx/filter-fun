// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

import {DeploySepolia} from "../script/DeploySepolia.s.sol";
import {SeedFilter} from "../script/SeedFilter.s.sol";
import {FilterLauncher} from "../src/FilterLauncher.sol";
import {FilterFactory} from "../src/FilterFactory.sol";
import {FilterHook} from "../src/FilterHook.sol";
import {POLVault} from "../src/POLVault.sol";
import {POLManager} from "../src/POLManager.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";

import {MockWETH} from "./mocks/MockWETH.sol";

/// @notice Deploy + seed correctness tests. Runs the actual `DeploySepolia` and
///         `SeedFilter` scripts in-process against a v4 PoolManager spun up via the
///         v4-core Deployers helper, then asserts:
///           - every deployed address is non-zero
///           - cross-wiring is correct (factory ↔ hook ↔ launcher ↔ POL stack)
///           - `setMaxLaunchesPerWallet` + `setRefundableStakeEnabled` were applied
///           - the manifest file lands on disk, contains the right chainId + addresses, and
///             has the salt cached so re-runs read it instead of re-mining
///           - re-running the script with a populated manifest reverts (idempotency)
///           - the `SeedFilter` script seeds $FILTER and refuses to double-seed
///
///         We don't fork the live network — the goal is to exercise the *script's* deploy
///         sequence and JSON output, not to validate Base Sepolia's PoolManager bytecode.
///         A separate vitest in the indexer package validates the manifest schema once a
///         real deploy runs.
///
///         Both scripts live in the same test contract so they run sequentially. Splitting
///         them into two contracts caused CI flakes: forge runs different test files in
///         parallel and they raced on shared `vm.setEnv` state (e.g. `MANIFEST_PATH_OVERRIDE`,
///         `V4_POOL_MANAGER_ADDRESS`), silently producing the wrong manifest path / pool
///         manager mid-test.
contract DeployTest is Test, Deployers {
    DeploySepolia internal deployer;
    SeedFilter internal seed;
    MockWETH internal weth;

    /// Deterministic Foundry default test wallet. The script reads it via
    /// `vm.envUint("DEPLOYER_PRIVATE_KEY")`; we hand the same value so `vm.addr(pk)` matches
    /// across the script and the test asserts.
    uint256 internal constant DEPLOYER_PK = uint256(keccak256("filter.fun.test.deployer"));

    /// Where the test writes its sandbox manifest. Picked to live under the same package so
    /// fs_permissions allow it; the `freshEnv` modifier wipes any leftover before every test.
    string internal constant TEST_MANIFEST = "./deployments/base-sepolia.test.json";

    address internal deployerAddr;
    address internal treasuryOwner = makeAddr("treasuryOwner");
    address internal scheduler = makeAddr("scheduler");
    address internal mechanics = makeAddr("mechanics");
    address internal polVaultOwner = makeAddr("polVaultOwner");

    function setUp() public {
        // Need a real V4 PoolManager so the FilterFactory constructor doesn't choke on its
        // poolManager call. Deployers gives us `manager` for free.
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        deployer = new DeploySepolia();
        seed = new SeedFilter();
        deployerAddr = vm.addr(DEPLOYER_PK);

        // Fund the deployer so `new` calls under broadcast don't OOG.
        vm.deal(deployerAddr, 100 ether);

        // The script asserts chainid == 84_532. Spoof it. (Doesn't affect anything else
        // in-test — V4 helpers don't care about chainid.)
        vm.chainId(84_532);
    }

    /// Modifier instead of `setUp()` because forge's per-test isolation mechanism reverts
    /// `vm.setEnv` mutations made inside `setUp()` before the test body runs (only mutations
    /// done in the test body itself persist into the test). That means `setUp` cannot reliably
    /// reset env state between tests; one test setting `FORCE_REDEPLOY=1` would leak into the
    /// next test's first `deployer.run()` and silently bypass the idempotency guard. Running
    /// the env-reset and manifest-wipe inside the test body via this modifier sidesteps that.
    modifier freshEnv() {
        if (vm.exists(TEST_MANIFEST)) vm.removeFile(TEST_MANIFEST);
        _setEnv();
        _;
    }

    function _setEnv() internal {
        vm.setEnv("MANIFEST_PATH_OVERRIDE", TEST_MANIFEST);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(DEPLOYER_PK)));
        vm.setEnv("V4_POOL_MANAGER_ADDRESS", vm.toString(address(manager)));
        vm.setEnv("WETH_ADDRESS", vm.toString(address(weth)));
        vm.setEnv("TREASURY_OWNER", vm.toString(treasuryOwner));
        vm.setEnv("SCHEDULER_ORACLE_ADDRESS", vm.toString(scheduler));
        vm.setEnv("MECHANICS_WALLET", vm.toString(mechanics));
        vm.setEnv("POL_VAULT_OWNER", vm.toString(polVaultOwner));
        vm.setEnv("MAX_LAUNCHES_PER_WALLET", "1");
        vm.setEnv("REFUNDABLE_STAKE_ENABLED", "true");
        vm.setEnv("DEPLOY_COMMIT_HASH", "test-commit-hash");
        // Process env is shared across test files / test runs in forge — explicitly clear
        // every knob that *another* test might have set, otherwise stale state leaks in.
        vm.setEnv("FORCE_REDEPLOY", "0");
        vm.setEnv("HOOK_SALT", "");
        // Used by SeedFilter; harmless when DeploySepolia tests run.
        vm.setEnv("FILTER_METADATA_URI", "ipfs://test-filter-metadata");
    }

    function test_DeployScriptProducesWiredSystem() public freshEnv {
        deployer.run();

        // Read the manifest back and pull every address.
        string memory m = vm.readFile(TEST_MANIFEST);
        assertEq(vm.parseJsonUint(m, ".chainId"), 84_532, "manifest chainId");
        assertEq(vm.parseJsonString(m, ".network"), "base-sepolia");
        assertEq(vm.parseJsonString(m, ".deployCommitHash"), "test-commit-hash");

        address treasury = vm.parseJsonAddress(m, ".addresses.treasuryTimelock");
        address bonus = vm.parseJsonAddress(m, ".addresses.bonusDistributor");
        address polVault = vm.parseJsonAddress(m, ".addresses.polVault");
        address launcher = vm.parseJsonAddress(m, ".addresses.filterLauncher");
        address polMgr = vm.parseJsonAddress(m, ".addresses.polManager");
        address hook = vm.parseJsonAddress(m, ".addresses.filterHook");
        address factory = vm.parseJsonAddress(m, ".addresses.filterFactory");
        address creatorReg = vm.parseJsonAddress(m, ".addresses.creatorRegistry");
        address creatorFee = vm.parseJsonAddress(m, ".addresses.creatorFeeDistributor");
        address creatorCom = vm.parseJsonAddress(m, ".addresses.creatorCommitments");
        address tournReg = vm.parseJsonAddress(m, ".addresses.tournamentRegistry");
        address tournVault = vm.parseJsonAddress(m, ".addresses.tournamentVault");
        address mPoolManager = vm.parseJsonAddress(m, ".addresses.v4PoolManager");
        address mWeth = vm.parseJsonAddress(m, ".addresses.weth");

        assertTrue(treasury != address(0), "treasury non-zero");
        assertTrue(bonus != address(0), "bonus non-zero");
        assertTrue(polVault != address(0), "polVault non-zero");
        assertTrue(launcher != address(0), "launcher non-zero");
        assertTrue(polMgr != address(0), "polManager non-zero");
        assertTrue(hook != address(0), "hook non-zero");
        assertTrue(factory != address(0), "factory non-zero");
        assertTrue(creatorReg != address(0), "creatorRegistry non-zero");
        assertTrue(creatorFee != address(0), "creatorFeeDistributor non-zero");
        assertTrue(creatorCom != address(0), "creatorCommitments non-zero");
        assertTrue(tournReg != address(0), "tournamentRegistry non-zero");
        assertTrue(tournVault != address(0), "tournamentVault non-zero");
        assertEq(mPoolManager, address(manager), "v4 pool manager passthrough");
        assertEq(mWeth, address(weth), "weth passthrough");

        // Hook flag bits must satisfy 0xA00 (BEFORE_ADD_LIQUIDITY | BEFORE_REMOVE_LIQUIDITY).
        assertEq(uint160(hook) & 0x3FFF, uint160(0xA00), "hook flag bits");

        // Wiring assertions.
        FilterLauncher l = FilterLauncher(launcher);
        assertEq(address(l.factory()), factory, "launcher.factory");
        assertEq(address(l.polManager()), polMgr, "launcher.polManager");
        assertEq(address(l.creatorRegistry()), creatorReg, "launcher.creatorRegistry");
        assertEq(address(l.creatorFeeDistributor()), creatorFee, "launcher.creatorFeeDistributor");
        assertEq(address(l.creatorCommitments()), creatorCom, "launcher.creatorCommitments");
        assertEq(address(l.tournamentRegistry()), tournReg, "launcher.tournamentRegistry");
        assertEq(address(l.tournamentVault()), tournVault, "launcher.tournamentVault");
        assertEq(l.oracle(), scheduler, "launcher.oracle");
        assertEq(l.treasury(), treasury, "launcher.treasury");
        assertEq(l.mechanics(), mechanics, "launcher.mechanics");
        assertEq(l.weth(), address(weth), "launcher.weth");
        assertEq(l.maxLaunchesPerWallet(), 1, "launcher.maxLaunchesPerWallet");
        assertTrue(l.refundableStakeEnabled(), "launcher.refundableStakeEnabled");
        assertEq(l.owner(), deployerAddr, "launcher.owner is deployer (rotate post-deploy)");

        // Hook is initialized; reverts to re-init.
        vm.expectRevert();
        FilterHook(hook).initialize(address(0xdead));

        // POLVault: ownership pending transfer to polVaultOwner (Ownable2Step).
        assertEq(POLVault(polVault).pendingOwner(), polVaultOwner, "POLVault pendingOwner");
        assertEq(POLVault(polVault).polManager(), polMgr, "POLVault.polManager");

        // Manifest config block round-trips.
        assertEq(vm.parseJsonAddress(m, ".config.treasuryOwner"), treasuryOwner, "config.treasuryOwner");
        assertEq(vm.parseJsonAddress(m, ".config.schedulerOracle"), scheduler, "config.schedulerOracle");
        assertEq(vm.parseJsonAddress(m, ".config.mechanicsWallet"), mechanics, "config.mechanicsWallet");
        assertEq(vm.parseJsonAddress(m, ".config.polVaultOwner"), polVaultOwner, "config.polVaultOwner");
        assertEq(vm.parseJsonUint(m, ".config.maxLaunchesPerWallet"), 1, "config.maxLaunchesPerWallet");
        assertTrue(vm.parseJsonBool(m, ".config.refundableStakeEnabled"), "config.refundableStakeEnabled");

        // Hook salt was persisted (non-zero implies the script wrote the mined value).
        bytes32 cachedSalt = vm.parseJsonBytes32(m, ".hookSalt");
        assertTrue(cachedSalt != bytes32(0), "hookSalt cached");
    }

    function test_DeployScriptIsIdempotent() public freshEnv {
        deployer.run();
        // Second run must revert because the manifest now records a real launcher address.
        vm.expectRevert(bytes("manifest exists; set FORCE_REDEPLOY=1 to overwrite"));
        deployer.run();
    }

    function test_DeployScriptHonorsForceRedeploy() public freshEnv {
        // Snapshot pre-deploy chain state so we can re-run from scratch (CREATE2 hook would
        // otherwise collide). FORCE_REDEPLOY only governs the manifest guard; the chain reset
        // simulates "operator removed the manifest, now redeploys cleanly".
        uint256 snap = vm.snapshot();
        deployer.run();
        address firstLauncher = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterLauncher");

        vm.revertTo(snap);
        // After revertTo, the chain state is reset but the manifest file remains on disk —
        // exactly the scenario FORCE_REDEPLOY guards against.
        vm.setEnv("FORCE_REDEPLOY", "1");
        deployer.run();
        address secondLauncher = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterLauncher");
        assertEq(firstLauncher, secondLauncher, "deterministic deploy: same launcher across reruns");
    }

    function test_DeployScriptUsesCachedHookSalt() public freshEnv {
        uint256 snap = vm.snapshot();
        deployer.run();
        bytes32 firstSalt = vm.parseJsonBytes32(vm.readFile(TEST_MANIFEST), ".hookSalt");
        address firstHook = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterHook");

        // Reset chain so the second deploy can re-place the hook at the cached address. Pass
        // the cached salt via env to skip the mining step — proves the env override path.
        vm.revertTo(snap);
        vm.setEnv("HOOK_SALT", vm.toString(firstSalt));
        vm.setEnv("FORCE_REDEPLOY", "1");
        deployer.run();
        bytes32 secondSalt = vm.parseJsonBytes32(vm.readFile(TEST_MANIFEST), ".hookSalt");
        address secondHook = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterHook");
        assertEq(secondSalt, firstSalt, "salt round-trips when supplied via env");
        assertEq(secondHook, firstHook, "hook lands at the same address with cached salt");
    }

    // ============================================================ SeedFilter

    /// Helper used by all SeedFilter tests: runs the deploy, pulls the launcher, and (when
    /// `openSeason` is true) pranks the oracle to start Season 1 so SeedFilter's pre-flight
    /// passes. Avoids duplicating the boilerplate four times.
    function _deployAndStartSeason(bool openSeason) internal returns (FilterLauncher launcher) {
        deployer.run();
        launcher =
            FilterLauncher(vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterLauncher"));
        if (openSeason) {
            vm.prank(scheduler);
            launcher.startSeason();
        }
    }

    function test_SeedFilterRefusesIfSeasonNotStarted() public freshEnv {
        _deployAndStartSeason(false);
        // No oracle call → currentSeasonId == 0 → script reverts at the pre-flight check.
        vm.expectRevert(bytes("no season open; oracle must call startSeason() first"));
        seed.run();
    }

    function test_SeedFilterRefusesIfPhaseNotLaunch() public freshEnv {
        FilterLauncher launcher = _deployAndStartSeason(true);
        vm.prank(scheduler);
        launcher.advancePhase(1, IFilterLauncher.Phase.Filter);

        vm.expectRevert(bytes("season not in Launch phase"));
        seed.run();
    }

    function test_SeedFilterPopulatesManifest() public freshEnv {
        FilterLauncher launcher = _deployAndStartSeason(true);
        seed.run();

        string memory manifest = vm.readFile(TEST_MANIFEST);
        address tokenAddr = vm.parseJsonAddress(manifest, ".filterToken.address");
        address lockerAddr = vm.parseJsonAddress(manifest, ".filterToken.locker");
        string memory name = vm.parseJsonString(manifest, ".filterToken.name");
        string memory symbol = vm.parseJsonString(manifest, ".filterToken.symbol");

        assertTrue(tokenAddr != address(0), "filterToken.address populated");
        assertTrue(lockerAddr != address(0), "filterToken.locker populated");
        assertEq(name, "filter");
        assertEq(symbol, "FILTER");

        // Spec §5.3: $FILTER takes its place in the season alongside public launches and is
        // *not* counted toward `launchCount`. Confirm both invariants.
        assertEq(launcher.launchCount(1), 0, "$FILTER doesn't count toward public launches");
        IFilterLauncher.TokenEntry memory entry = launcher.entryOf(1, tokenAddr);
        assertEq(entry.token, tokenAddr, "token registered in season");
        assertTrue(entry.isProtocolLaunched, "marked as protocol-launched");
    }

    /// Bugbot regression: after a first successful seed the manifest stores `.filterToken`
    /// as an object. The original guard probed `.filterToken` as a string, threw on the
    /// object, and the catch silently allowed the second seed. Fixed guard probes
    /// `.filterToken.address` and refuses when it's non-zero.
    function test_SeedFilterRefusesDoubleSeed() public freshEnv {
        _deployAndStartSeason(true);
        seed.run();
        vm.expectRevert(bytes("manifest.filterToken already set; remove it to re-seed"));
        seed.run();
    }
}
