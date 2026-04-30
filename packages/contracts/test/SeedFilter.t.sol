// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

import {DeploySepolia} from "../script/DeploySepolia.s.sol";
import {SeedFilter} from "../script/SeedFilter.s.sol";
import {FilterLauncher} from "../src/FilterLauncher.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";

import {MockWETH} from "./mocks/MockWETH.sol";

/// @notice SeedFilter behavior tests. Exercises the actual `SeedFilter` script in-process,
///         after running `DeploySepolia` to produce a real manifest + deployed launcher.
///
///         Two regressions are pinned here:
///
///         1. **Double-seed guard with object-shaped `filterToken`** — bugbot caught this
///            on the initial Epic 1.6 PR. After a successful seed the manifest's
///            `.filterToken` becomes a JSON *object* (with `address`, `locker`, etc.),
///            not the empty string DeploySepolia leaves. The earlier guard probed
///            `parseJsonString(".filterToken")`, which threw on an object and the catch
///            silently treated it as "no filterToken yet" — letting a second run overwrite
///            the manifest. The fix probes `.filterToken.address` instead.
///
///         2. **Pre-flight phase check** — the script must refuse to run if the oracle
///            hasn't called `startSeason()` yet. We exercise the revert.
contract SeedFilterTest is Test, Deployers {
    DeploySepolia internal deploy;
    SeedFilter internal seed;
    MockWETH internal weth;

    uint256 internal constant DEPLOYER_PK = uint256(keccak256("filter.fun.test.deployer"));
    string internal constant TEST_MANIFEST = "./deployments/base-sepolia.test.json";

    address internal deployerAddr;
    address internal treasuryOwner = makeAddr("treasuryOwner");
    address internal scheduler = makeAddr("scheduler");
    address internal mechanics = makeAddr("mechanics");
    address internal polVaultOwner = makeAddr("polVaultOwner");

    FilterLauncher internal launcher;

    function setUp() public {
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        deploy = new DeploySepolia();
        seed = new SeedFilter();
        deployerAddr = vm.addr(DEPLOYER_PK);
        vm.deal(deployerAddr, 100 ether);
        vm.chainId(84_532);

        if (vm.exists(TEST_MANIFEST)) vm.removeFile(TEST_MANIFEST);
        _setEnv();

        // Run DeploySepolia to populate the manifest + deploy a live launcher this test can
        // drive. The launcher's owner is `deployerAddr` (the script's broadcaster).
        deploy.run();
        launcher = FilterLauncher(vm.parseJsonAddress(vm.readFile(TEST_MANIFEST), ".addresses.filterLauncher"));
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
        vm.setEnv("FORCE_REDEPLOY", "0");
        vm.setEnv("HOOK_SALT", "");
        vm.setEnv("FILTER_METADATA_URI", "ipfs://test-filter-metadata");
    }

    function test_RefusesIfSeasonNotStarted() public {
        // No oracle call yet → currentSeasonId == 0 → script reverts.
        vm.expectRevert(bytes("no season open; oracle must call startSeason() first"));
        seed.run();
    }

    function test_RefusesIfPhaseNotLaunch() public {
        // Open season then advance past Launch.
        vm.prank(scheduler);
        launcher.startSeason();
        vm.prank(scheduler);
        launcher.advancePhase(1, IFilterLauncher.Phase.Filter);

        vm.expectRevert(bytes("season not in Launch phase"));
        seed.run();
    }

    function test_SeedsFilterAndPopulatesManifest() public {
        vm.prank(scheduler);
        launcher.startSeason();

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
    /// as an object. The earlier guard used `parseJsonString` and silently fell through; the
    /// fixed guard uses `parseJsonAddress(".filterToken.address")` and refuses.
    function test_RefusesDoubleSeed() public {
        vm.prank(scheduler);
        launcher.startSeason();

        seed.run();
        vm.expectRevert(bytes("manifest.filterToken already set; remove it to re-seed"));
        seed.run();
    }
}
