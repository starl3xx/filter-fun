// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {ScriptUtils} from "../script/ScriptUtils.sol";

/// @notice Pins the chainid → network-slug mapping the whole deploy pipeline hangs off
///         (manifest filenames + the manifest `network` field consumed by the indexer's
///         `normalizeNetwork` and the web's `ChainSlug` union — 2026-07 Robinhood
///         retarget). A silent slug change would strand both consumers on their
///         cross-network guard, so every supported id is asserted exactly.
contract ScriptUtilsTest is Test {
    function test_NetworkSlugForChain_AllSupportedIds() public pure {
        assertEq(ScriptUtils.networkSlugForChain(4663), "robinhood");
        assertEq(ScriptUtils.networkSlugForChain(46_630), "robinhood-testnet");
        assertEq(ScriptUtils.networkSlugForChain(8453), "base");
        assertEq(ScriptUtils.networkSlugForChain(84_532), "base-sepolia");
    }

    function test_NetworkSlugForChain_RevertsOnUnknownChain() public {
        // Wrapped through an external call so the library revert is catchable.
        vm.expectRevert(bytes("ScriptUtils: no network slug for chainid 1"));
        this.slugOf(1);
    }

    function test_ManifestPath_DerivesFromChainid() public {
        // Clear the override every test in Deploy.t.sol sets — process-wide env.
        vm.setEnv("MANIFEST_PATH_OVERRIDE", "");
        vm.chainId(46_630);
        assertEq(ScriptUtils.manifestPath(), "./deployments/robinhood-testnet.json");
        vm.chainId(4663);
        assertEq(ScriptUtils.manifestPath(), "./deployments/robinhood.json");
        vm.chainId(84_532);
        assertEq(ScriptUtils.manifestPath(), "./deployments/base-sepolia.json");
    }

    function test_ManifestPath_OverrideWins() public {
        vm.setEnv("MANIFEST_PATH_OVERRIDE", "./deployments/custom.test.json");
        vm.chainId(46_630);
        assertEq(ScriptUtils.manifestPath(), "./deployments/custom.test.json");
        vm.setEnv("MANIFEST_PATH_OVERRIDE", "");
    }

    /// External wrapper so `expectRevert` can catch the internal-library revert.
    function slugOf(uint256 chainid) external pure returns (string memory) {
        return ScriptUtils.networkSlugForChain(chainid);
    }
}
