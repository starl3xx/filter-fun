// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

import {DeploySepolia} from "../script/DeploySepolia.s.sol";
import {SeedFilter} from "../script/SeedFilter.s.sol";
import {VerifySepolia} from "../script/VerifySepolia.s.sol";
import {RedeployFactory} from "../script/RedeployFactory.s.sol";
import {FilterLauncher} from "../src/FilterLauncher.sol";
import {FilterFactory} from "../src/FilterFactory.sol";
import {FilterHook} from "../src/FilterHook.sol";
import {POLVault} from "../src/POLVault.sol";
import {POLManager} from "../src/POLManager.sol";
import {BonusDistributor} from "../src/BonusDistributor.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
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
    VerifySepolia internal verify;
    RedeployFactory internal redeploy;
    MockWETH internal weth;

    /// VerifySepolia.run() emits this on success. Mirrored locally so the test can decode
    /// it from `vm.recordLogs()` without importing the script's event ABI directly.
    event VerifySepoliaOK(
        uint256 chainId,
        address filterLauncher,
        uint256 maxLaunchesPerWallet,
        bool filterTokenChecked,
        address filterToken,
        uint256 tokensChecked
    );

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
        verify = new VerifySepolia();
        redeploy = new RedeployFactory();
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
        // Used by VerifySepolia; verifier ignores it when callers pass `runWithFlags(...)`
        // directly, but reset it so any operator-style `verify.run()` reaches a known state.
        vm.setEnv("SKIP_FILTER_TOKEN_CHECK", "0");
        // Used by RedeployFactory; default to refusing rotations that would orphan public
        // launches. Tests that exercise the override toggle this explicitly.
        vm.setEnv("ACTIVE_LAUNCH_OK", "0");
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

    // ============================================================ VerifySepolia
    //
    // Operational verifier tests. Live in the same contract as Deploy + SeedFilter for the
    // same reason those two are co-located: forge runs separate test FILES in parallel and
    // they would race on shared `vm.setEnv` knobs (`MANIFEST_PATH_OVERRIDE`,
    // `V4_POOL_MANAGER_ADDRESS`, etc.). Keeping every script test in one contract guarantees
    // sequential execution.
    //
    // The verifier is read-only — the tests deploy + (optionally) seed, then run
    // `verify.runWithFlags(skipFilter)` and either:
    //   - decode the emitted `VerifySepoliaOK` event for happy paths, or
    //   - assert the specific `AssertionFailed_<n>` revert for failure paths.
    //
    // We call `runWithFlags(...)` directly instead of `run()` so the test passes the skip
    // flag explicitly, sidestepping forge's per-test env-isolation snapshot quirks.

    /// Helper: deploy + open season + seed $FILTER, returning the launcher.
    function _deployAndSeed() internal returns (FilterLauncher launcher) {
        launcher = _deployAndStartSeason(true);
        seed.run();
    }

    /// Decoded form of the VerifySepoliaOK event, easier to assert against than raw logs.
    struct VerifyOKLog {
        uint256 chainId;
        address filterLauncher;
        uint256 maxLaunchesPerWallet;
        bool filterTokenChecked;
        address filterToken;
        uint256 tokensChecked;
    }

    /// Locate the single VerifySepoliaOK entry in a recorded log batch and decode it.
    /// Reverts if the event isn't present — the verifier emits exactly one on success.
    function _findOkLog(Vm.Log[] memory logs) internal pure returns (VerifyOKLog memory ev) {
        bytes32 sig = keccak256("VerifySepoliaOK(uint256,address,uint256,bool,address,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) {
                (
                    ev.chainId,
                    ev.filterLauncher,
                    ev.maxLaunchesPerWallet,
                    ev.filterTokenChecked,
                    ev.filterToken,
                    ev.tokensChecked
                ) = abi.decode(logs[i].data, (uint256, address, uint256, bool, address, uint256));
                return ev;
            }
        }
        revert("VerifySepoliaOK event not found in recorded logs");
    }

    /// Full happy path: deploy, seed $FILTER, run verifier, decode the emitted
    /// VerifySepoliaOK event and assert the addresses + counts match what the verifier
    /// actually inspected.
    function test_VerifyHappyPathWithFilterSeeded() public freshEnv {
        FilterLauncher launcher = _deployAndSeed();
        address filterToken = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".filterToken.address");

        vm.recordLogs();
        verify.runWithFlags(false);
        VerifyOKLog memory ev = _findOkLog(vm.getRecordedLogs());

        assertEq(ev.chainId, 84_532, "ev.chainId");
        assertEq(ev.filterLauncher, address(launcher), "ev.filterLauncher");
        assertEq(ev.maxLaunchesPerWallet, 1, "ev.maxLaunchesPerWallet");
        assertTrue(ev.filterTokenChecked, "ev.filterTokenChecked");
        assertEq(ev.filterToken, filterToken, "ev.filterToken");
        assertEq(ev.tokensChecked, 1, "ev.tokensChecked");
    }

    /// Pre-seed verification: deploy but don't run SeedFilter, verify with skip flag set.
    /// This is the path an operator uses post-deploy / pre-`launchProtocolToken` to confirm
    /// wiring before opening a season.
    function test_VerifyHappyPathSkipFilterToken() public freshEnv {
        FilterLauncher launcher = _deployAndStartSeason(false);

        vm.recordLogs();
        verify.runWithFlags(true);
        VerifyOKLog memory ev = _findOkLog(vm.getRecordedLogs());

        assertEq(ev.chainId, 84_532, "ev.chainId");
        assertEq(ev.filterLauncher, address(launcher), "ev.filterLauncher");
        assertEq(ev.maxLaunchesPerWallet, 1, "ev.maxLaunchesPerWallet");
        assertFalse(ev.filterTokenChecked, "ev.filterTokenChecked");
        assertEq(ev.filterToken, address(0), "ev.filterToken (skipped)");
        assertEq(ev.tokensChecked, 0, "ev.tokensChecked (no season)");
    }

    /// Assertion 1 — verifier hard-codes SPEC_MAX_LAUNCHES = 1 (spec §4.6). To force a
    /// mismatch we deploy with the spec value, then directly poke the launcher's storage
    /// via the owner-only setter to flip the on-chain cap to 2. The verifier should then
    /// surface the assertion-1 revert.
    function test_VerifyFailsOnMaxLaunchesMismatch() public freshEnv {
        FilterLauncher launcher = _deployAndStartSeason(false);
        // Owner is the deployer EOA; flip the cap to 2 so the verifier's spec-locked
        // expected (1) doesn't match.
        vm.prank(deployerAddr);
        launcher.setMaxLaunchesPerWallet(2);

        // skipFilter=true so we don't trip assertion 2a before reaching assertion 1
        // (the deploy alone leaves filterToken.address=0).
        vm.expectRevert(bytes("AssertionFailed_1: maxLaunchesPerWallet != spec 4.6 lock (1)"));
        verify.runWithFlags(true);
    }

    /// Assertion 2a — manifest.filterToken.address is zero (DeploySepolia placeholder)
    /// and the verifier wasn't told to skip. Should revert with the assertion-2a message
    /// pointing the operator at SKIP_FILTER_TOKEN_CHECK.
    function test_VerifyFailsWhenFilterTokenZeroAndNotSkipped() public freshEnv {
        _deployAndStartSeason(false);

        vm.expectRevert(
            bytes(
                "AssertionFailed_2a: manifest.filterToken.address is zero - set SKIP_FILTER_TOKEN_CHECK=1 if pre-seed"
            )
        );
        verify.runWithFlags(false);
    }

    /// Assertion 5 — admin diverges from creator. The default is admin == creator (no
    /// override set), so to break the invariant we run a full nominate + accept rotation
    /// to a different EOA, then verify and expect the revert.
    function test_VerifyFailsWhenAdminDivergesFromCreator() public freshEnv {
        _deployAndSeed();
        address filterToken = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".filterToken.address");
        CreatorRegistry creatorRegistry =
            CreatorRegistry(vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.creatorRegistry"));

        // $FILTER's creator-of-record is the deployer EOA: `launchProtocolToken` is owner-
        // gated and `_launch` records `msg.sender` as the creator. The launcher contract
        // itself never calls into CreatorRegistry as the creator. Prank as the deployer
        // (current admin since no override exists) to rotate admin to a different wallet.
        address newAdmin = makeAddr("verifyDivergedAdmin");
        vm.prank(deployerAddr);
        creatorRegistry.nominateAdmin(filterToken, newAdmin);
        vm.prank(newAdmin);
        creatorRegistry.acceptAdmin(filterToken);

        // Sanity: post-rotation, adminOf differs from creatorOf.
        assertEq(creatorRegistry.creatorOf(filterToken), deployerAddr);
        assertEq(creatorRegistry.adminOf(filterToken), newAdmin);

        vm.expectRevert(
            bytes("AssertionFailed_5: creatorRegistry.adminOf != creatorOf for at least one token")
        );
        verify.runWithFlags(false);
    }

    /// Idempotency: running the verifier multiple times produces the same result without
    /// touching chain state. Read-only by construction; this just confirms a re-run doesn't
    /// trip up on cached cheatcode state.
    function test_VerifyIsIdempotent() public freshEnv {
        _deployAndSeed();
        verify.runWithFlags(false);
        verify.runWithFlags(false);
        verify.runWithFlags(false);
    }

    // ============================================================ RedeployFactory
    //
    // Operator-facing factory rotation. The script wraps DeploySepolia with FORCE_REDEPLOY=1
    // plus an active-launch safety guard and a manifest-archive step. Tests cover:
    //   - happy path (deploy → seed → archive + redeploy → emits event with old/new pair)
    //   - active-launch refusal without ACTIVE_LAUNCH_OK=1
    //   - missing-manifest refusal

    /// Mirrors RedeployFactory.FactoryRedeployed for vm.expectEmit.
    event FactoryRedeployed(
        address indexed oldFactory,
        address indexed newFactory,
        address indexed oldLauncher,
        address newLauncher,
        string archivePath
    );

    /// Happy path: prior deploy + seeded $FILTER, no public launches → rotation succeeds,
    /// archive lands on disk, manifest now points at NEW factory + launcher addresses,
    /// and the new FilterHook lands at a fresh CREATE2 address (RedeployFactory mines a
    /// salt strictly above the prior one, sidestepping the collision a naive redeploy
    /// would hit on a live chain).
    function test_RedeployFactoryHappyPath() public freshEnv {
        _deployAndSeed();
        address oldFactory = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterFactory");
        address oldLauncher = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterLauncher");
        address oldHook = vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterHook");
        bytes32 oldSalt = vm.parseJsonBytes32(vm.readFile(TEST_MANIFEST), ".hookSalt");

        vm.recordLogs();
        redeploy.run();

        // Pull addresses from the freshly-written manifest.
        string memory after_ = vm.readFile(TEST_MANIFEST);
        address newFactory = vm.parseJsonAddress(after_, ".addresses.filterFactory");
        address newLauncher = vm.parseJsonAddress(after_, ".addresses.filterLauncher");
        address newHook = vm.parseJsonAddress(after_, ".addresses.filterHook");
        bytes32 newSalt = vm.parseJsonBytes32(after_, ".hookSalt");
        assertTrue(newFactory != oldFactory, "factory rotated");
        assertTrue(newLauncher != oldLauncher, "launcher rotated");
        assertTrue(newHook != oldHook, "hook rotated to fresh CREATE2 slot");
        assertTrue(uint256(newSalt) > uint256(oldSalt), "fresh salt strictly above prior");

        // Archive directory exists and contains the prior manifest.
        assertTrue(vm.exists("./deployments/archive"), "archive dir created");

        // FactoryRedeployed event present in logs with correct old/new.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FactoryRedeployed(address,address,address,address,string)");
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length >= 4 && logs[i].topics[0] == sig) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), oldFactory, "topic.oldFactory");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), newFactory, "topic.newFactory");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), oldLauncher, "topic.oldLauncher");
                found = true;
                break;
            }
        }
        assertTrue(found, "FactoryRedeployed event emitted");
    }

    /// Refusal path: a public launch exists in the current season → script reverts unless
    /// ACTIVE_LAUNCH_OK=1. We open a season, set baseLaunchCost to 0 so the test wallet can
    /// launch without funding gymnastics, then call launchToken so launchCount > 0.
    function test_RedeployFactoryRefusesWithActiveLaunch() public freshEnv {
        FilterLauncher launcher = _deployAndStartSeason(true);

        // Drop launch cost to zero so the prank-call below doesn't need ETH.
        vm.prank(deployerAddr);
        launcher.setBaseLaunchCost(0);

        address launcherCaller = makeAddr("publicLauncher");
        vm.deal(launcherCaller, 1 ether);
        vm.prank(launcherCaller);
        launcher.launchToken("token", "TKN", "ipfs://test");
        assertEq(launcher.launchCount(1), 1, "active launch recorded");

        vm.expectRevert(bytes("RedeployFactory: active launches present; set ACTIVE_LAUNCH_OK=1 to override"));
        redeploy.run();
    }

    /// Refusal path: no manifest → script bails with a clear message instead of silently
    /// running the deploy from scratch (which would mask operator typos in MANIFEST_PATH_OVERRIDE).
    function test_RedeployFactoryRefusesWhenManifestMissing() public freshEnv {
        // freshEnv already removed the manifest. Don't run deployer.run() so it stays missing.
        vm.expectRevert(bytes("RedeployFactory: manifest missing - nothing to rotate"));
        redeploy.run();
    }
}
