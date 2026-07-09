// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice Shared helpers used by every operations script (DeployTestnet, DeployGenesis,
///         SeedFilter, VerifySepolia, RedeployFactory). Keeping them in one place
///         eliminates the drift risk the bugbot flagged on PR #46 — a future whitelist
///         tweak (e.g. accepting "yes"/"no") needs to land in exactly one location
///         instead of three or four.
///
///         Every function here is `internal` so the call sites get inlining instead of a
///         `delegatecall` link step. The library uses the standard forge-std `vm` constant
///         pattern (Vm at the cheatcode address) so it doesn't need to inherit from `Script`.
library ScriptUtils {
    /// Forge cheatcode handler address. Identical to the constant inside `forge-std/Vm.sol`.
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // ============================================================ Network identity

    /// Canonical network slug for every chain the deploy pipeline supports (2026-07
    /// Robinhood Chain retarget — one pipeline, four networks). The slug names the
    /// manifest file (`deployments/<slug>.json`) and is written into the manifest's
    /// `network` field; the indexer's `normalizeNetwork` and the web's `ChainSlug` union
    /// accept exactly these values, so a typo here breaks both consumers loudly (their
    /// cross-network guard skips a mismatched manifest). Reverting on an unknown chainid
    /// (rather than defaulting) keeps a fat-fingered `--rpc-url` from writing a manifest
    /// under the wrong identity.
    function networkSlugForChain(uint256 chainid) internal pure returns (string memory) {
        if (chainid == 4663) return "robinhood";
        if (chainid == 46_630) return "robinhood-testnet";
        if (chainid == 8453) return "base";
        if (chainid == 84_532) return "base-sepolia";
        revert(string.concat("ScriptUtils: no network slug for chainid ", uintToString(chainid)));
    }

    // ============================================================ Env helpers

    /// Read the manifest path with optional env override. The default derives from
    /// `block.chainid`, so every script pointed at the same RPC reads/writes the same
    /// file with zero configuration. Operators override via `MANIFEST_PATH_OVERRIDE`
    /// (used by every test in `Deploy.t.sol`); empty-string override falls back to the
    /// default — guards against the operator setting `MANIFEST_PATH_OVERRIDE=` (no
    /// value) and accidentally reading from / writing to the wrong file.
    function manifestPath() internal view returns (string memory) {
        string memory fallbackPath =
            string.concat("./deployments/", networkSlugForChain(block.chainid), ".json");
        try vm.envString("MANIFEST_PATH_OVERRIDE") returns (string memory v) {
            return bytes(v).length == 0 ? fallbackPath : v;
        } catch {
            return fallbackPath;
        }
    }

    /// Accept either `DEPLOYER_PRIVATE_KEY` (per spec) or `PRIVATE_KEY` (legacy convention).
    function envPrivateKey() internal view returns (uint256) {
        try vm.envUint("DEPLOYER_PRIVATE_KEY") returns (uint256 pk) {
            return pk;
        } catch {
            return vm.envUint("PRIVATE_KEY");
        }
    }

    /// Strict-whitelist boolean parser. Accepts `1`/`0`/`true`/`TRUE`/`false`/`FALSE` and
    /// rejects everything else with a clear revert (including `True`/`yes`/etc.). Unset env
    /// returns `fallback_`; explicitly empty (`KEY=`) also returns `fallback_`.
    ///
    /// Why a custom parser instead of `vm.envBool`? Two reasons:
    ///   1. forge-std versions have churned on bool-parser tolerance; pinning behavior here
    ///      keeps deploys reproducible across forge upgrades.
    ///   2. env state leaks across forge test files (process-wide), and a misparse would
    ///      silently bypass guards like `FORCE_REDEPLOY`. Loud failure beats silent
    ///      surprise — the operator should see a revert if they typed `True` (capital T)
    ///      and assumed it would be accepted.
    function envBool(string memory key, bool fallback_) internal view returns (bool) {
        try vm.envString(key) returns (string memory raw) {
            if (bytes(raw).length == 0) return fallback_;
            bytes32 h = keccak256(bytes(raw));
            if (h == keccak256("1") || h == keccak256("true") || h == keccak256("TRUE")) {
                return true;
            }
            if (h == keccak256("0") || h == keccak256("false") || h == keccak256("FALSE")) {
                return false;
            }
            revert(string.concat("ScriptUtils: unrecognized boolean for ", key, "; expected 1/0/true/false"));
        } catch {
            return fallback_;
        }
    }

    // ============================================================ JSON-emit helpers
    //
    // Hand-built primitives used by `ManifestWriter`'s and `SeedFilter`'s manifest writers.
    // We don't go through `vm.serializeXxx` because its builder state is process-global and
    // races across parallel forge test files (see `SeedFilter._appendFilterToken` for the
    // full back-story).

    /// Lowercase 0x-prefixed hex address. `vm.toString(address)` emits EIP-55 mixed-case
    /// which is fine but inconsistent across runs; we normalize so manifest diffs are clean.
    function addrToString(address a) internal pure returns (string memory) {
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

    /// Lowercase 0x-prefixed hex bytes32. Same rationale as `addrToString`.
    function bytes32ToHex(bytes32 v) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(v[i]);
            out[2 + i * 2] = hexChars[b >> 4];
            out[2 + i * 2 + 1] = hexChars[b & 0x0f];
        }
        return string(out);
    }

    /// Decimal `uint256` → string. `vm.toString` works too but routes through a cheatcode;
    /// keeping this local lets pure helpers stay pure.
    function uintToString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 digits;
        while (tmp != 0) {
            ++digits;
            tmp /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            --digits;
            buf[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
