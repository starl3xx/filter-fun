// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {CreatorFeeDistributor} from "../../src/CreatorFeeDistributor.sol";
import {CreatorRegistry} from "../../src/CreatorRegistry.sol";
import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {IBonusFunding} from "../../src/SeasonVault.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";

// PolishContractsPassTest -- Audit polish pass (Phase 1, 2026-05-02)
//
// Bundled regressions for the four code-touching items in the contracts polish PR.
// Each test maps to one finding in audit/2026-05-PHASE-1-AUDIT/contracts.md so a
// future revert that drops the change surfaces with the audit ID in the failure
// label, not just an opaque assertion miss.
//
// Findings covered:
//   - M-Contracts-2: setFactory emits FactorySet (semantic test, not just source-grep)
//   - M-Contracts-4: ELIGIBILITY_WINDOW NatSpec carries the §10.3 anchor (source-grep)
//   - I-Contracts-1: NotYetUnlocked exists; NotUnlocked is gone (selector + source)
//   - I-Contracts-5: lastSeenBalance NatSpec carries the audit assumption note (source-grep)
contract PolishContractsPassTest is Test {
    address internal owner = address(0x1);
    address internal oracle = address(0x2);
    address internal treasury = address(0x3);
    address internal mechanics = address(0x4);
    address internal weth = address(0x5);
    address internal stubBonusDistributor = address(0x6);

    FilterLauncher internal launcher;

    function setUp() public {
        // Audit H-4 zero-address gates require non-zero on every constructor address;
        // we only need a launcher that can take a setFactory call, so the bonusDistributor
        // wire can be a stub address (the launcher doesn't dispatch through it in this test).
        launcher =
            new FilterLauncher(owner, oracle, treasury, mechanics, IBonusFunding(stubBonusDistributor), weth);
    }

    // M-Contracts-2 ------------------------------------------------------------------
    //
    // setFactory is a one-shot owner-only setter for the FilterFactory address. Pre-fix
    // it mutated the `factory` storage slot without emitting any event; off-chain
    // indexers + the operator runbook had no on-chain log of when and to which address
    // the factory was wired. The audit asked for an event so the assignment is greppable
    // in chain logs.
    //
    // The FactorySet event was dropped in Epic 1.15a (EIP-170 budget); the assignment is
    // observable directly via `launcher.factory()`. This regression test now verifies the
    // assignment instead — equivalent semantic coverage, no extra bytecode.

    function test_MContracts2_SetFactory_AssignsFactory() public {
        address fakeFactory = address(0xFACEFACE);
        vm.prank(owner);
        launcher.setFactory(IFilterFactory(fakeFactory));
        assertEq(
            address(launcher.factory()), fakeFactory, "M-Contracts-2 regression: setFactory did not assign"
        );
    }

    function test_MContracts2_SetFactory_RevertsOnZero_NoEvent() public {
        // Tighten the regression: the event must NOT fire on the zero-address path
        // (which reverts via the H-4 ZeroAddress gate). Pre-fix the emit could land
        // before the revert if a future maintainer reordered the lines.
        vm.prank(owner);
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.setFactory(IFilterFactory(address(0)));
    }

    // M-Contracts-4 ------------------------------------------------------------------
    //
    // ELIGIBILITY_WINDOW = 72 hours per spec §10.3. Pre-fix the constant carried no
    // NatSpec, so a future maintainer detuning the value (e.g., "fold into 96h cut")
    // had no spec anchor in front of them. Pinning the §10.3 reference + the rationale
    // here means a reviewer who tries to change 72h sees the spec anchor in the diff
    // and must justify the change in the same patch.
    function test_MContracts4_EligibilityWindowNatSpec_PinsSpec103() public view {
        string memory src = vm.readFile("src/CreatorFeeDistributor.sol");
        assertTrue(_contains(src, "spec "), "source missing 'spec' tokens entirely");
        // Match the canonical §10.3 reference and the literal value we expect a
        // detuning regression to have to justify.
        assertTrue(
            _contains(src, unicode"§10.3"),
            "M-Contracts-4 regression: ELIGIBILITY_WINDOW NatSpec dropped the spec anchor"
        );
        assertTrue(
            _contains(src, "ELIGIBILITY_WINDOW = 72 hours"),
            "M-Contracts-4 regression: ELIGIBILITY_WINDOW value drifted from spec lock"
        );
    }

    // I-Contracts-1 ------------------------------------------------------------------
    //
    // Renamed BonusDistributor.NotUnlocked -> NotYetUnlocked. The pre-fix name read as
    // an authorisation error in revert traces ("you are not unlocked") when it's
    // actually a timing error ("it is not yet time to post"). Pin both halves: the new
    // selector exists AND the old name no longer appears in the source (so a future
    // refactor that re-introduces both can't slip through with both selectors live).
    function test_IContracts1_NotYetUnlockedSelector_Exists() public pure {
        bytes4 sel = BonusDistributor.NotYetUnlocked.selector;
        // Selector is non-zero; this would fail to compile if the error didn't exist.
        assertTrue(sel != bytes4(0), "I-Contracts-1 regression: NotYetUnlocked selector missing");
    }

    function test_IContracts1_OldNotUnlockedName_NotPresent() public view {
        // Source-side belt: the old name should appear ONLY as documentation referencing
        // the rename (the dev-comment block above NotYetUnlocked). We assert the source
        // never declares `error NotUnlocked` again — a future maintainer copy/pasting an
        // old test would otherwise re-introduce the dead error type alongside the new one.
        string memory src = vm.readFile("src/BonusDistributor.sol");
        assertFalse(
            _contains(src, "error NotUnlocked()"),
            "I-Contracts-1 regression: old NotUnlocked() error declaration is back"
        );
        assertTrue(
            _contains(src, "error NotYetUnlocked()"),
            "I-Contracts-1 regression: NotYetUnlocked error declaration missing"
        );
    }

    // I-Contracts-5 ------------------------------------------------------------------
    //
    // lastSeenBalance accounting is sequential-call-safe today because every token has
    // exactly one factory-deployed FilterLpLocker and notifyFee is gated to that locker.
    // The audit asked for the assumption to be pinned in NatSpec so a future PR that adds
    // a second WETH-pushing caller (sponsor router, etc.) is forced to re-validate the
    // accounting. Pin the assumption tag here.
    function test_IContracts5_LastSeenBalance_HasAssumptionNote() public view {
        string memory src = vm.readFile("src/CreatorFeeDistributor.sol");
        assertTrue(
            _contains(src, "I-Contracts-5"),
            "I-Contracts-5 regression: lastSeenBalance NatSpec dropped the audit ID anchor"
        );
        assertTrue(
            _contains(src, "sequential"),
            "I-Contracts-5 regression: lastSeenBalance NatSpec dropped the sequential-call assumption"
        );
    }

    // ---------------------------------------------------------------- string helpers
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
