// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

// BonusDistributorNatSpecTest -- Audit Finding H-1 (Phase 1, 2026-05-01)
//
// The Phase-1 audit (audit/2026-05-PHASE-1-AUDIT/contracts.md High #1) flagged that
// BonusDistributor's three external state-mutating entry points (fundBonus, postRoot,
// claim) shipped with minimal "@notice" lines and no per-parameter docs. For an audit-
// bound surface that participates in Merkle-rooted settlement, missing parameter
// semantics is a reviewer hazard -- a maintainer could mis-pass unlockTime
// (block number vs. timestamp) or amount (raw vs. decimal-adjusted) without the doc to
// anchor the contract.
//
// This test enforces the doc surface as a build-time invariant: the BonusDistributor
// source must contain a doc-comment block (consecutive "///" lines) immediately
// preceding each of the three target functions, AND the block must contain "@notice"
// + at least one per-parameter doc tag for every signature parameter.
//
// Note on encoding: this file uses plain "//" line comments, NOT "///", because solc
// treats "@notice"/parameter-tag tokens inside "///" comments as actual NatSpec tags
// and rejects them with "Documentation tag @<x>` not valid for contracts." The needles
// the test searches for are constructed at runtime via string.concat so the "@" token
// never appears inside a Solidity-recognised NatSpec block.
//
// Test outcome contract:
//   - Pre-fix: claim/postRoot/fundBonus had a "@notice" only, no per-parameter docs --
//     so the per-function param-count check FAILS for at least one of them.
//   - Post-fix: every target function carries "@notice" + one per-parameter doc tag
//     for every parameter in its signature.
//
// Why a string-grep test rather than slither/solhint: this repo's CI doesn't yet run a
// NatSpec linter, and adding one is a follow-up. A focused regression test pinned to
// the three audit-flagged functions catches the exact regression we're worried about
// with zero new tooling dependencies. If/when the repo adopts a general NatSpec lint,
// this test becomes redundant and can be deleted.
contract BonusDistributorNatSpecTest is Test {
    string internal constant SOURCE_PATH = "src/BonusDistributor.sol";

    function test_AuditH1_FundBonusHasNatSpec() public view {
        _assertHasNatSpec("fundBonus", 4);
    }

    function test_AuditH1_PostRootHasNatSpec() public view {
        _assertHasNatSpec("postRoot", 2);
    }

    function test_AuditH1_ClaimHasNatSpec() public view {
        _assertHasNatSpec("claim", 3);
    }

    // _assertHasNatSpec walks BonusDistributor.sol, finds where the function is declared,
    // collects the immediately-preceding "///" doc-comment block, and asserts the block
    // contains a "@notice" tag and at least `expectedParams` distinct parameter-doc tags.
    // Both needles are built via string.concat so the source of THIS file does not contain
    // any literal NatSpec tags solc would reject.
    function _assertHasNatSpec(string memory fnName, uint256 expectedParams) internal view {
        string memory at = "@";
        string memory noticeNeedle = string.concat(at, "notice");
        string memory paramNeedle = string.concat(at, "param");

        string memory src = vm.readFile(SOURCE_PATH);
        string[] memory lines = _splitLines(src);

        int256 fnLine = _findFunctionLine(lines, fnName);
        assertGe(fnLine, int256(0), string.concat("function not found in source: ", fnName));

        uint256 noticeCount;
        uint256 paramCount;
        for (int256 i = fnLine - 1; i >= 0; --i) {
            string memory ln = _trimLeft(lines[uint256(i)]);
            bytes memory b = bytes(ln);
            if (b.length < 3 || b[0] != "/" || b[1] != "/" || b[2] != "/") break;
            if (_contains(ln, noticeNeedle)) ++noticeCount;
            if (_contains(ln, paramNeedle)) ++paramCount;
        }

        assertGt(
            noticeCount, 0, string.concat("H-1 regression: missing notice on BonusDistributor.", fnName)
        );
        assertGe(
            paramCount,
            expectedParams,
            string.concat(
                "H-1 regression: insufficient per-parameter doc coverage on BonusDistributor.", fnName
            )
        );
    }

    function _findFunctionLine(string[] memory lines, string memory fnName) internal pure returns (int256) {
        string memory needle = string.concat("function ", fnName, "(");
        for (uint256 i = 0; i < lines.length; ++i) {
            if (_contains(lines[i], needle)) return int256(i);
        }
        return -1;
    }

    function _splitLines(string memory s) internal pure returns (string[] memory out) {
        bytes memory b = bytes(s);
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == "\n") ++count;
        }
        out = new string[](count);
        uint256 idx;
        uint256 start;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == "\n") {
                out[idx++] = _slice(b, start, i);
                start = i + 1;
            }
        }
        out[idx] = _slice(b, start, b.length);
    }

    function _slice(bytes memory b, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory out = new bytes(end - start);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = b[start + i];
        }
        return string(out);
    }

    function _trimLeft(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 i;
        while (i < b.length && (b[i] == " " || b[i] == "\t")) ++i;
        bytes memory out = new bytes(b.length - i);
        for (uint256 j = 0; j < out.length; ++j) {
            out[j] = b[i + j];
        }
        return string(out);
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length == 0) return true;
        if (h.length < n.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            bool match_ = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }
}
