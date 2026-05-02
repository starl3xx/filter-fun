// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {BonusDistributor} from "../../src/BonusDistributor.sol";

/// @title BonusDistributorSetOracleNamingTest -- Audit Finding H-3 (Phase 1, 2026-05-01)
/// @notice The Phase-1 audit (`audit/2026-05-PHASE-1-AUDIT/contracts.md` High #3) flagged
///         that `BonusDistributor.setOracle` reverted with `NotOracle()` when called by a
///         non-launcher account. The revert reason mis-signaled the failed predicate: the
///         caller did not need to be the oracle, they needed to be the LAUNCHER. A
///         monitoring tool grepping for `NotOracle` events would conflate two distinct
///         policy violations (oracle misconfig vs. launcher misconfig), and a maintainer
///         debugging a reverted `setOracle` would chase the wrong identity entirely.
///
///         Fix: introduce `error NotLauncher()`, route the auth gate through an
///         `onlyLauncher` modifier, and have `setOracle` revert with `NotLauncher` on a
///         non-launcher caller.
///
///         Test outcome contract:
///           - Pre-fix: `test_AuditH3_SetOracleRevertsWithNotLauncherFromAdversary` FAILS
///             (vault reverts with NotOracle.selector instead of NotLauncher.selector).
///           - Post-fix: both auth tests PASS; the legitimate-launcher-rotation test PASSES
///             unchanged (just structural cover so a regression that broke setOracle's
///             happy path also gets caught here).
contract BonusDistributorSetOracleNamingTest is Test {
    BonusDistributor distributor;

    address launcher = address(0x9999);
    address weth = address(0xAAAA);
    address oracleA = address(0xA1A1);
    address oracleB = address(0xB2B2);
    address adversary = address(0xBADD);

    function setUp() public {
        distributor = new BonusDistributor(launcher, weth, oracleA);
    }

    function test_AuditH3_SetOracleRevertsWithNotLauncherFromAdversary() public {
        vm.prank(adversary);
        vm.expectRevert(BonusDistributor.NotLauncher.selector);
        distributor.setOracle(oracleB);
    }

    /// @notice The currently-configured oracle is also NOT the launcher; calling setOracle
    ///         from the oracle's address must hit the same `NotLauncher` revert. Pre-fix the
    ///         confusion was even worse here because the oracle calling its own rotation
    ///         entry would get back `NotOracle()` — a contradiction in terms.
    function test_AuditH3_SetOracleRevertsWithNotLauncherFromOracle() public {
        vm.prank(oracleA);
        vm.expectRevert(BonusDistributor.NotLauncher.selector);
        distributor.setOracle(oracleB);
    }

    /// @notice Happy path — the configured launcher CAN rotate the oracle. Pinned so a
    ///         regression that breaks the legitimate gate (e.g. accidentally swapping the
    ///         comparison) lights up here too.
    function test_AuditH3_LauncherCanRotateOracle() public {
        vm.prank(launcher);
        distributor.setOracle(oracleB);
        assertEq(distributor.oracle(), oracleB, "oracle did not rotate to oracleB");
    }
}
