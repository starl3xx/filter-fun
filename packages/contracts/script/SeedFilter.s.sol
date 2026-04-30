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
    string internal constant MANIFEST_PATH = "./deployments/base-sepolia.json";

    function run() external {
        require(vm.exists(MANIFEST_PATH), "manifest missing; run DeploySepolia first");
        string memory manifest = vm.readFile(MANIFEST_PATH);

        address launcherAddr = vm.parseJsonAddress(manifest, ".addresses.filterLauncher");
        require(launcherAddr != address(0), "launcher address missing from manifest");

        // Refuse to double-seed. We don't want a second protocol-launch silently overwriting
        // the manifest's `filterToken` and orphaning the original token off-chain visibility.
        try vm.parseJsonString(manifest, ".filterToken") returns (string memory existing) {
            require(bytes(existing).length == 0, "manifest.filterToken already set; remove it to re-seed");
        } catch {
            // No filterToken key — fine, treat as fresh.
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
        (address token, address locker) =
            launcher.launchProtocolToken("filter", "FILTER", metadataUri);
        vm.stopBroadcast();

        console2.log("$FILTER token:  ", token);
        console2.log("$FILTER locker: ", locker);

        _appendFilterToken(manifest, token, locker, metadataUri);
    }

    /// Persist `filterToken` (and locker / metadata) into the manifest. We rebuild the JSON via
    /// Foundry's serializer rather than string-splicing — `vm.writeJson(value, path, key)` lets
    /// us overwrite a single key without re-serializing the whole document, but only for scalar
    /// keys. Since we want both `filterToken` (object) and to keep all prior keys, the cleanest
    /// path is `vm.writeJson(serialized, path, ".filterToken")`.
    function _appendFilterToken(
        string memory, /* manifest */
        address token,
        address locker,
        string memory metadataUri
    ) internal {
        string memory key = "filterToken";
        vm.serializeAddress(key, "address", token);
        vm.serializeAddress(key, "locker", locker);
        vm.serializeString(key, "name", "filter");
        vm.serializeString(key, "symbol", "FILTER");
        vm.serializeUint(key, "seededAt", block.timestamp);
        string memory value = vm.serializeString(key, "metadataURI", metadataUri);

        // Targeted write: replaces only the `filterToken` key in the manifest, leaving every
        // other key untouched. Avoids any chance of dropping addresses we wrote earlier.
        vm.writeJson(value, MANIFEST_PATH, ".filterToken");
    }

    function _envPrivateKey() internal view returns (uint256) {
        try vm.envUint("DEPLOYER_PRIVATE_KEY") returns (uint256 pk) {
            return pk;
        } catch {
            return vm.envUint("PRIVATE_KEY");
        }
    }
}
