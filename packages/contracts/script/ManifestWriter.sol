// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {ScriptUtils} from "./ScriptUtils.sol";

/// @notice Shared deploy-manifest emitter, extracted from `DeploySepolia` (now
///         `DeployTestnet`) in the 2026-07 Robinhood Chain retarget so that
///         `DeployGenesis` writes a manifest too — previously the mainnet script wrote
///         nothing, but the indexer (`packages/indexer/src/deployment.ts`) and web
///         (`scripts/sync-deployment.mjs`) both read the manifest as their canonical
///         address source on EVERY network. One writer, two scripts, zero drift.
///
///         The manifest's `network` field derives from `block.chainid` via
///         `ScriptUtils.networkSlugForChain`, so the same writer emits
///         `robinhood`, `robinhood-testnet`, `base`, or `base-sepolia` correctly.
abstract contract ManifestWriter {
    Vm private constant _vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Manifest write. Two sub-objects (`addresses` + `config`) plus top-level metadata.
    /// `filterToken` is left null — `SeedFilter.s.sol` populates it after the protocol launch.
    struct ManifestArgs {
        address deployer;
        bytes32 hookSalt;
        address treasury;
        address bonus;
        address polVault;
        address clubPass;
        uint256 clubMintPrice;
        uint256 clubMaxSupply;
        address launcher;
        address launchEscrow;
        address launcherStakeAdmin;
        address polManager;
        address hook;
        address factory;
        address creatorRegistry;
        address creatorFeeDistributor;
        address creatorCommitments;
        address tournamentRegistry;
        address tournamentVault;
        address v4PoolManager;
        address weth;
        address treasuryOwner;
        address oracle;
        address mechanics;
        address polVaultOwner;
        bool refundableStake;
    }

    /// Manual JSON construction. We deliberately bypass Foundry's `vm.serialize*` builder
    /// here because that cheatcode caches state per-id at the cheatcode-handler level and
    /// the cache persists across script invocations in the same forge process. Across our
    /// test suite that surfaced as flaky failures: stale fields from a prior run bled into
    /// the current write, producing malformed JSON or wrong addresses. Manual string-concat
    /// is verbose but completely stateless — every call writes exactly what we asked for.
    /// Each value goes through a typed quoter (`_quoteAddr` / `_quoteBytes32`) that emits
    /// JSON-valid output without escaping concerns.
    function _writeManifest(string memory path, ManifestArgs memory a) internal {
        string memory addressesObj = string.concat(
            "{",
            _kv("treasuryTimelock", a.treasury),
            ",",
            _kv("bonusDistributor", a.bonus),
            ",",
            _kv("polVault", a.polVault),
            ",",
            _kv("filterClubPass", a.clubPass),
            ",",
            _kv("filterLauncher", a.launcher),
            ",",
            _kv("launchEscrow", a.launchEscrow),
            ",",
            _kv("launcherStakeAdmin", a.launcherStakeAdmin),
            ",",
            _kv("polManager", a.polManager),
            ",",
            _kv("filterHook", a.hook),
            ",",
            _kv("filterFactory", a.factory),
            ",",
            _kv("creatorRegistry", a.creatorRegistry),
            ",",
            _kv("creatorFeeDistributor", a.creatorFeeDistributor),
            ",",
            _kv("creatorCommitments", a.creatorCommitments),
            ",",
            _kv("tournamentRegistry", a.tournamentRegistry),
            ",",
            _kv("tournamentVault", a.tournamentVault),
            ",",
            _kv("v4PoolManager", a.v4PoolManager),
            ",",
            _kv("weth", a.weth),
            "}"
        );

        string memory configObj = string.concat(
            "{",
            _kv("treasuryOwner", a.treasuryOwner),
            ",",
            _kv("schedulerOracle", a.oracle),
            ",",
            _kv("mechanicsWallet", a.mechanics),
            ",",
            _kv("polVaultOwner", a.polVaultOwner),
            ",",
            _kvBool("refundableStakeEnabled", a.refundableStake),
            ",",
            _kvUint("filterClubMintPriceWei", a.clubMintPrice),
            ",",
            _kvUint("filterClubMaxSupply", a.clubMaxSupply),
            "}"
        );

        // `filterToken` placeholder. MUST be an object (not a string) so SeedFilter can
        // overwrite via `vm.writeJson(value, path, ".filterToken")` — that cheatcode rejects
        // a scalar destination. Zero addresses signal "not yet seeded"; SeedFilter's guard
        // probes `.filterToken.address != address(0)` to refuse double-seed.
        string memory filterTokenObj = string.concat(
            "{",
            _kv("address", address(0)),
            ",",
            _kv("locker", address(0)),
            ",",
            _kvStr("name", ""),
            ",",
            _kvStr("symbol", ""),
            ",",
            _kvUint("seededAt", 0),
            ",",
            _kvStr("metadataURI", ""),
            "}"
        );

        string memory finalJson = string.concat(
            "{",
            _kvUint("chainId", block.chainid),
            ",",
            _kvStr("network", ScriptUtils.networkSlugForChain(block.chainid)),
            ",",
            _kvUint("deployBlockNumber", block.number),
            ",",
            _kvUint("deployedAt", block.timestamp),
            ",",
            _kv("deployerAddress", a.deployer),
            ",",
            _kvBytes32("hookSalt", a.hookSalt),
            ",",
            _kvRaw("filterToken", filterTokenObj),
            ",",
            _kvStr("deployCommitHash", _envOrDefaultString("DEPLOY_COMMIT_HASH", "unknown")),
            ",",
            _kvRaw("addresses", addressesObj),
            ",",
            _kvRaw("config", configObj),
            "}"
        );

        _vm.writeJson(finalJson, path);
    }

    // ---------- JSON-emit helpers ----------
    //
    // The address/uint/bytes32 stringifiers live in `ScriptUtils` so `SeedFilter` can
    // share the address formatter. The `_kv*` wrappers stay here because they're glue
    // that pre-formats keys for this manifest's specific shape — not generally reusable.

    function _kv(string memory key, address value) internal pure returns (string memory) {
        return string.concat("\"", key, "\":\"", ScriptUtils.addrToString(value), "\"");
    }

    function _kvStr(string memory key, string memory value) internal pure returns (string memory) {
        return string.concat("\"", key, "\":\"", value, "\"");
    }

    function _kvUint(string memory key, uint256 value) internal pure returns (string memory) {
        return string.concat("\"", key, "\":", ScriptUtils.uintToString(value));
    }

    function _kvBool(string memory key, bool value) internal pure returns (string memory) {
        return string.concat("\"", key, "\":", value ? "true" : "false");
    }

    function _kvBytes32(string memory key, bytes32 value) internal pure returns (string memory) {
        return string.concat("\"", key, "\":\"", ScriptUtils.bytes32ToHex(value), "\"");
    }

    function _kvRaw(string memory key, string memory rawJson) internal pure returns (string memory) {
        return string.concat("\"", key, "\":", rawJson);
    }

    function _envOrDefaultString(string memory key, string memory fallback_)
        internal
        view
        returns (string memory)
    {
        try _vm.envString(key) returns (string memory v) {
            return bytes(v).length == 0 ? fallback_ : v;
        } catch {
            return fallback_;
        }
    }
}
