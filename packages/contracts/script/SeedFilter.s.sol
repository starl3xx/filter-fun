// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {FilterLauncher} from "../src/FilterLauncher.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";

/// @notice Seeds the testnet rehearsal $FILTER token via the protocol-launch bypass at
///         FilterLauncher.launchProtocolToken. Reads the launcher address from the deploy
///         manifest, calls the bypass, and writes the resulting token + locker addresses
///         back into the manifest.
///
///         Spec §5.3 credibility constraint: $FILTER must be able to lose. The launcher's
///         protocol-launch path runs through the same `_launch()` as a public launch with
///         `isProtocolLaunched = true`. That flag is recorded for indexing/UX, but it does
///         NOT alter HP, scoring, settlement eligibility, rollover, or filter pressure —
///         the protocol token competes on equal terms with public launches. This script is
///         a thin admin wrapper around that path; it adds no special accounting.
///
///         Required env:
///           DEPLOYER_PRIVATE_KEY     launcher owner (also accepts PRIVATE_KEY)
///           FILTER_METADATA_URI      ipfs:// URI for the $FILTER metadata JSON
///                                    (name "filter", symbol "FILTER", description
///                                    "Genesis token of filter.fun. Must be able to lose.")
///
///         Pre-conditions (script asserts and refuses to broadcast otherwise):
///           - manifest at deployments/base-sepolia.json exists with a launcher address
///           - launcher.currentSeasonId() > 0 and current phase == Launch
///           - manifest.filterToken is empty (don't double-seed)
contract SeedFilter is Script {
    string internal constant DEFAULT_MANIFEST_PATH = "./deployments/base-sepolia.json";

    function run() external {
        string memory manifestPath = _manifestPath();
        require(vm.exists(manifestPath), "manifest missing; run DeploySepolia first");
        string memory manifest = vm.readFile(manifestPath);

        address launcherAddr = vm.parseJsonAddress(manifest, ".addresses.filterLauncher");
        require(launcherAddr != address(0), "launcher address missing from manifest");

        // Refuse to double-seed. After DeploySepolia the manifest carries `filterToken: ""`
        // (empty string), and after the first successful SeedFilter it carries an object
        // `{ "address": "0x...", "locker": "0x...", ... }`. We probe `.filterToken.address`:
        // if it exists and is non-zero, the seed already ran. The earlier draft probed
        // `.filterToken` as a string — which silently fell into the `catch` after the first
        // seed (because the key shape changed from string to object) and bypassed the guard
        // entirely, allowing a second seed to overwrite the manifest. Bugbot caught this.
        try vm.parseJsonAddress(manifest, ".filterToken.address") returns (address existing) {
            require(existing == address(0), "manifest.filterToken already set; remove it to re-seed");
        } catch {
            // `.filterToken` is absent or not an object → fresh state, proceed.
        }

        string memory metadataUri = vm.envString("FILTER_METADATA_URI");
        require(bytes(metadataUri).length > 0, "FILTER_METADATA_URI required");

        uint256 pk = _envPrivateKey();
        FilterLauncher launcher = FilterLauncher(launcherAddr);

        // Pre-flight: season must be open and in Launch phase. Catches the "deployed but oracle
        // hasn't called startSeason yet" footgun before we burn gas on a revert.
        uint256 seasonId = launcher.currentSeasonId();
        require(seasonId > 0, "no season open; oracle must call startSeason() first");
        IFilterLauncher.Phase phase = launcher.phaseOf(seasonId);
        require(phase == IFilterLauncher.Phase.Launch, "season not in Launch phase");

        console2.log("=== SeedFilter ===");
        console2.log("launcher:    ", launcherAddr);
        console2.log("seasonId:    ", seasonId);
        console2.log("metadataURI: ", metadataUri);

        vm.startBroadcast(pk);
        (address token, address locker) = launcher.launchProtocolToken("filter", "FILTER", metadataUri);
        vm.stopBroadcast();

        console2.log("$FILTER token:  ", token);
        console2.log("$FILTER locker: ", locker);

        _appendFilterToken(manifestPath, token, locker, metadataUri);
    }

    /// Persist `filterToken` (and locker / metadata) into the manifest. We hand-build the JSON
    /// rather than using `vm.serializeXxx` because the serializer caches builder state on a
    /// process-global, cheatcode-handler-level keyed map. Even with per-invocation unique keys,
    /// across parallel forge test files (forge runs different test contracts on different
    /// threads in the same process) the serializer racily emits `DuplicateSymbol()` or builds
    /// inconsistent JSON. Hand-building dodges that entirely — the output is plain
    /// `string.concat`, identical to `DeploySepolia`'s manifest emission.
    function _appendFilterToken(
        string memory manifestPath,
        address token,
        address locker,
        string memory metadataUri
    ) internal {
        string memory value = string.concat(
            "{",
            "\"address\":\"",
            _addrToString(token),
            "\",",
            "\"locker\":\"",
            _addrToString(locker),
            "\",",
            "\"name\":\"filter\",",
            "\"symbol\":\"FILTER\",",
            "\"seededAt\":",
            vm.toString(block.timestamp),
            ",",
            "\"metadataURI\":\"",
            metadataUri,
            "\"",
            "}"
        );

        // Targeted write: replaces only the `filterToken` key in the manifest, leaving every
        // other key untouched. Avoids any chance of dropping addresses we wrote earlier.
        vm.writeJson(value, manifestPath, ".filterToken");
    }

    /// Lowercase hex address with `0x` prefix — matches `DeploySepolia._addrToString` so the
    /// manifest is consistent across the two writers. (`vm.toString(address)` emits EIP-55
    /// mixed-case which is fine but inconsistent across runs; we normalize to lowercase so
    /// the manifest output is deterministic for diffs and downstream parsing.)
    function _addrToString(address a) private pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 value = uint160(a);
        for (uint256 i = 0; i < 20; ++i) {
            uint8 b = uint8(value >> (8 * (19 - i)));
            out[2 + i * 2] = hexChars[b >> 4];
            out[2 + i * 2 + 1] = hexChars[b & 0x0f];
        }
        return string(out);
    }

    /// Manifest path with optional env override — keeps tests from clobbering the real
    /// `./deployments/base-sepolia.json` and mirrors the pattern in `DeploySepolia.s.sol`.
    function _manifestPath() internal view returns (string memory) {
        try vm.envString("MANIFEST_PATH_OVERRIDE") returns (string memory v) {
            return bytes(v).length == 0 ? DEFAULT_MANIFEST_PATH : v;
        } catch {
            return DEFAULT_MANIFEST_PATH;
        }
    }

    function _envPrivateKey() internal view returns (uint256) {
        try vm.envUint("DEPLOYER_PRIVATE_KEY") returns (uint256 pk) {
            return pk;
        } catch {
            return vm.envUint("PRIVATE_KEY");
        }
    }
}
