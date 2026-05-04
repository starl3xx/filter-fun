// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {DeploySepolia} from "./DeploySepolia.s.sol";
import {ScriptUtils} from "./ScriptUtils.sol";
import {FilterLauncher} from "../src/FilterLauncher.sol";
import {FilterHook} from "../src/FilterHook.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice Operator-facing wrapper that rotates the FilterFactory by performing a full
///         force-redeploy via DeploySepolia. Required after PR #43 (CreatorCommitments
///         wiring) on testnet, where the live factory was deployed without the new
///         CreatorCommitments constructor argument and therefore cannot pass it through
///         to newly-launched tokens.
///
///         Why a full redeploy and not just a factory swap?
///
///           FilterLauncher.setFactory is a one-shot: `require(factory == address(0))` on
///           the setter (FilterLauncher.sol:200-203) means once the launcher is wired to a
///           factory, that link is immutable. The factory itself is also immutable (no
///           upgradeability). So changing the factory means changing the launcher; changing
///           the launcher means changing every contract that holds it (POLManager,
///           TournamentRegistry, FilterHook). That cascade is what `DeploySepolia` already
///           does — there's no smaller-blast-radius primitive available without contract
///           changes (e.g., adding a `rotateFactory(address)` admin path), which is out of
///           scope here.
///
///         Safety guards:
///
///           1. ACTIVE_LAUNCH_OK=0 (default) — refuse to redeploy if the current season has
///              any public launches. Operators must set ACTIVE_LAUNCH_OK=1 to acknowledge
///              that those launches will be orphaned by the rotation. (The deploy itself
///              also requires FORCE_REDEPLOY=1, set by this script unconditionally.)
///
///           2. Manifest archive — the existing manifest is copied to
///              `./deployments/archive/base-sepolia-<unix-ts>.json` before the new deploy
///              writes over it. Operators retain a record of the prior addresses for
///              orphan-token cleanup or post-mortem analysis.
///
///         Emits a `FactoryRedeployed(oldFactory, newFactory, oldLauncher, newLauncher)`
///         event so the trace can be correlated against on-chain bookkeeping. After the
///         redeploy, operators must:
///
///           1. Update indexer + scheduler + web envs to point at the new launcher.
///           2. Re-run SeedFilter.s.sol to populate $FILTER on the new system.
///           3. Run VerifySepolia.s.sol to confirm the new wiring matches spec.
///           4. Run nominateAdmin/acceptAdmin if any creator-of-record needs to migrate
///              admin rights to a different wallet (orphan creator entries on the OLD
///              registry remain pointing at the old token addresses; nothing on the new
///              registry references them).
contract RedeployFactory is Script {
    /// @notice Emitted on success. Surfaces the addresses we rotated AWAY from and the new
    ///         ones we rotated TO so the script trace is self-contained.
    event FactoryRedeployed(
        address indexed oldFactory,
        address indexed newFactory,
        address indexed oldLauncher,
        address newLauncher,
        string archivePath
    );

    string internal constant ARCHIVE_DIR = "./deployments/archive";

    /// Canonical CREATE2 deployer used by forge under broadcast — must match
    /// `DeploySepolia.DETERMINISTIC_DEPLOYER`. Hardcoded here to avoid importing private
    /// state from DeploySepolia just for one constant; both must move together.
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// Hook flag bits required by FilterHook: BEFORE_ADD_LIQUIDITY (1<<11) | BEFORE_REMOVE_LIQUIDITY (1<<9).
    uint160 internal constant HOOK_FLAGS = 0xA00;

    function run() external {
        string memory manifestPath = ScriptUtils.manifestPath();
        require(vm.exists(manifestPath), "RedeployFactory: manifest missing - nothing to rotate");

        string memory existing = vm.readFile(manifestPath);
        address oldFactory = vm.parseJsonAddress(existing, ".addresses.filterFactory");
        address oldLauncher = vm.parseJsonAddress(existing, ".addresses.filterLauncher");
        require(oldLauncher != address(0), "RedeployFactory: prior launcher missing from manifest");
        require(oldFactory != address(0), "RedeployFactory: prior factory missing from manifest");

        // ------------------------------------------------------------ Active-launch guard
        // The launcher only exists if the prior deploy at least reached the manifest-write
        // step. If it's also been used to open a season, we have to know whether public
        // launches happened — those tokens are orphaned by the rotation. Fail loudly unless
        // the operator explicitly opts in.
        bool ackActiveLaunch = ScriptUtils.envBool("ACTIVE_LAUNCH_OK", false);
        FilterLauncher launcher = FilterLauncher(payable(oldLauncher));
        uint256 sid = launcher.currentSeasonId();
        uint64 activeCount;
        if (sid > 0) {
            activeCount = launcher.launchCount(sid);
            IFilterLauncher.Phase phase = launcher.phaseOf(sid);
            console2.log("RedeployFactory: prior season", sid);
            console2.log("RedeployFactory:   public launchCount", activeCount);
            console2.log("RedeployFactory:   phase", uint256(phase));
        }
        if (activeCount > 0 && !ackActiveLaunch) {
            console2.log("RedeployFactory: prior season has public launches; rotating will orphan them.");
            console2.log("  Set ACTIVE_LAUNCH_OK=1 to acknowledge and proceed.");
            revert("RedeployFactory: active launches present; set ACTIVE_LAUNCH_OK=1 to override");
        }

        // ------------------------------------------------------------ Mine fresh hook salt
        // FilterHook's bytecode is identical between the prior and new deploy, so the
        // lowest-nonce flag-matching salt yields the SAME CREATE2 address — already
        // occupied by the prior hook. We mine starting at `priorSalt + 1` to guarantee a
        // fresh address. The override is passed via `HOOK_SALT` env so DeploySepolia picks
        // it up via its standard `_readOrMineHookSalt()` path.
        bytes32 priorSalt = vm.parseJsonBytes32(existing, ".hookSalt");
        (address newHook, bytes32 newSalt) = HookMiner.findFrom(
            DETERMINISTIC_DEPLOYER, HOOK_FLAGS, type(FilterHook).creationCode, uint256(priorSalt) + 1
        );
        require(newHook.code.length == 0, "RedeployFactory: mined hook address is already occupied");
        vm.setEnv("HOOK_SALT", vm.toString(newSalt));
        console2.log("RedeployFactory: mined fresh hook salt");
        console2.logBytes32(newSalt);
        console2.log("RedeployFactory: target hook address", newHook);

        // ------------------------------------------------------------ Archive prior manifest
        string memory archivePath = _archivePath(manifestPath);
        // Archive directory is created opportunistically — vm.createDir with the recursive
        // flag is idempotent on existing dirs.
        vm.createDir(ARCHIVE_DIR, true);
        vm.writeFile(archivePath, existing);
        console2.log("RedeployFactory: archived prior manifest at", archivePath);

        // ------------------------------------------------------------ Force redeploy
        // FORCE_REDEPLOY=1 makes DeploySepolia overwrite the existing manifest. We don't
        // touch the operator's other env vars — they must already have a valid deploy env
        // configured (DEPLOYER_PRIVATE_KEY, V4_POOL_MANAGER_ADDRESS, etc.) since we're
        // running the same deploy script they ran originally.
        vm.setEnv("FORCE_REDEPLOY", "1");
        DeploySepolia deploy = new DeploySepolia();
        deploy.run();

        // ------------------------------------------------------------ Read new addresses
        string memory newManifest = vm.readFile(manifestPath);
        address newFactory = vm.parseJsonAddress(newManifest, ".addresses.filterFactory");
        address newLauncher = vm.parseJsonAddress(newManifest, ".addresses.filterLauncher");
        require(newFactory != address(0), "RedeployFactory: post-deploy factory missing from manifest");
        require(newLauncher != address(0), "RedeployFactory: post-deploy launcher missing from manifest");
        require(newFactory != oldFactory, "RedeployFactory: factory address unchanged - redeploy was a no-op");

        emit FactoryRedeployed({
            oldFactory: oldFactory,
            newFactory: newFactory,
            oldLauncher: oldLauncher,
            newLauncher: newLauncher,
            archivePath: archivePath
        });

        console2.log("=== FactoryRedeployed ===");
        console2.log("  old factory:  ", oldFactory);
        console2.log("  new factory:  ", newFactory);
        console2.log("  old launcher: ", oldLauncher);
        console2.log("  new launcher: ", newLauncher);
        console2.log("Next: update indexer/scheduler/web envs, re-seed $FILTER, run VerifySepolia.");
    }

    // ============================================================ Helpers

    /// Build a timestamped archive path. Reuses the manifest's basename so a glob across the
    /// archive dir lists entries chronologically by mtime AND name.
    function _archivePath(string memory manifestPath) internal view returns (string memory) {
        // Strip the directory prefix and `.json` suffix to get the basename, then re-attach.
        // We don't need full path-parsing; the manifest path is operator-controlled and the
        // default form is `./deployments/base-sepolia.json`.
        bytes memory raw = bytes(manifestPath);
        uint256 sep = 0;
        for (uint256 i = 0; i < raw.length; ++i) {
            if (raw[i] == "/") sep = i + 1;
        }
        bytes memory tail = new bytes(raw.length - sep);
        for (uint256 i = 0; i < tail.length; ++i) {
            tail[i] = raw[sep + i];
        }
        // Drop trailing `.json` if present so we can splice the timestamp before it.
        string memory base = string(tail);
        if (_endsWith(base, ".json")) {
            bytes memory b = bytes(base);
            bytes memory trimmed = new bytes(b.length - 5);
            for (uint256 i = 0; i < trimmed.length; ++i) {
                trimmed[i] = b[i];
            }
            base = string(trimmed);
        }
        return string.concat(ARCHIVE_DIR, "/", base, "-", vm.toString(block.timestamp), ".json");
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory bs = bytes(s);
        bytes memory bf = bytes(suffix);
        if (bf.length > bs.length) return false;
        for (uint256 i = 0; i < bf.length; ++i) {
            if (bs[bs.length - bf.length + i] != bf[i]) return false;
        }
        return true;
    }
}
