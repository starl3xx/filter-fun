// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {
    SeasonVault,
    IBonusFunding,
    IPOLManager,
    ICreatorRegistry,
    ICreatorFeeDistributor,
    ITournamentRegistry
} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockLauncherView} from "../mocks/MockLauncherView.sol";
import {MockPOLManager} from "../mocks/MockPOLManager.sol";
import {MockCreatorRegistry} from "../mocks/MockCreatorRegistry.sol";
import {MockCreatorFeeDistributor} from "../mocks/MockCreatorFeeDistributor.sol";
import {MockTournamentRegistry} from "../mocks/MockTournamentRegistry.sol";

/// @title SeasonVaultOracleStaleness -- Audit Finding H-2 (Phase 1, 2026-05-01)
/// @notice The Phase-1 audit (`audit/2026-05-PHASE-1-AUDIT/contracts.md` High #2) flagged
///         that `SeasonVault` stored a per-vault `oracle` field set at construction time.
///         When the operator rotated `FilterLauncher.oracle` mid-protocol-life (the spec
///         §42.2.6-supported recovery path for a leaked oracle key), every existing
///         `SeasonVault` continued honouring the OLD oracle indefinitely — a Sev: High
///         finding because settlement on still-Active prior seasons stayed signable by a
///         presumed-rotated key.
///
///         Fix (live-read pattern, mirrors `TournamentRegistry`/`TournamentVault`):
///         `SeasonVault.onlyOracle` now reads `launcher.oracle()` on every privileged call.
///         The stored `oracle` field was dropped entirely; constructor no longer takes
///         `oracle_`. A `setOracle` rotation on the launcher takes effect on every
///         existing per-season vault immediately.
///
///         Test outcome contract:
///           - Pre-fix (vault stored its own oracle): `test_AuditH2_PrevOracleRejectedAfterRotation`
///             FAILS — the prev oracle's call succeeds (or reverts with EmptyEvent rather
///             than NotOracle, depending on the path), proving stored-oracle staleness.
///           - Post-fix (live-read): all four tests PASS. Prev oracle gets NotOracle on
///             every privileged entry, new oracle gets through, vault has no `oracle()`
///             function (the field was removed), and rotations propagate immediately.
contract SeasonVaultOracleStalenessTest is Test {
    MockWETH weth;
    MockLauncherView launcher;
    BonusDistributor bonus;
    MockPOLManager polManager;
    MockCreatorRegistry creatorRegistry;
    MockCreatorFeeDistributor creatorFeeDistributor;
    MockTournamentRegistry tournamentRegistry;
    SeasonVault vault;

    address oracleA = address(0xA1A1);
    address oracleB = address(0xB2B2);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);

    function setUp() public {
        weth = new MockWETH();
        launcher = new MockLauncherView();
        launcher.setOracle(oracleA);
        bonus = new BonusDistributor(address(launcher), address(weth), oracleA);
        polManager = new MockPOLManager(weth);
        creatorRegistry = new MockCreatorRegistry();
        creatorFeeDistributor = new MockCreatorFeeDistributor();
        tournamentRegistry = new MockTournamentRegistry();
        vault = new SeasonVault(
            address(launcher),
            1,
            address(weth),
            treasury,
            mechanics,
            IPOLManager(address(polManager)),
            IBonusFunding(address(bonus)),
            14 days,
            ICreatorRegistry(address(creatorRegistry)),
            ICreatorFeeDistributor(address(creatorFeeDistributor)),
            ITournamentRegistry(address(tournamentRegistry))
        );
        launcher.setVault(1, address(vault));
    }

    /// @notice Pre-rotation, the original oracle has authority. Sanity check that the
    ///         live-read auth path actually allows the configured oracle through — distinct
    ///         from the post-rotation rejection assertion below.
    function test_AuditH2_OriginalOracleHasAuthorityBeforeRotation() public {
        address[] memory empty = new address[](0);
        uint256[] memory emptyOuts = new uint256[](0);
        vm.prank(oracleA);
        // EmptyEvent (NOT NotOracle) means the auth modifier passed and the body's empty-
        // array guard fired. That's the discriminator.
        vm.expectRevert(SeasonVault.EmptyEvent.selector);
        vault.processFilterEvent(empty, emptyOuts);
    }

    /// @notice After rotating `launcher.oracle()` from oracleA to oracleB, oracleA must
    ///         lose authority on the existing vault. This is the load-bearing H-2 property:
    ///         pre-fix the vault still honoured oracleA; post-fix the live-read picks up
    ///         the new oracle on the very next call.
    function test_AuditH2_PrevOracleRejectedAfterRotation() public {
        launcher.setOracle(oracleB);

        address[] memory empty = new address[](0);
        uint256[] memory emptyOuts = new uint256[](0);
        vm.prank(oracleA);
        vm.expectRevert(SeasonVault.NotOracle.selector);
        vault.processFilterEvent(empty, emptyOuts);
    }

    /// @notice The new oracle must immediately be authorised on every existing per-season
    ///         vault — no per-vault setter call required. This proves the rotation
    ///         propagated, complementing the rejection assertion above.
    function test_AuditH2_NewOracleAuthorisedAfterRotation() public {
        launcher.setOracle(oracleB);

        address[] memory empty = new address[](0);
        uint256[] memory emptyOuts = new uint256[](0);
        vm.prank(oracleB);
        vm.expectRevert(SeasonVault.EmptyEvent.selector);
        vault.processFilterEvent(empty, emptyOuts);
    }

    /// @notice The H-2 fix dropped the stored `oracle` field. Reading `vault.oracle()` is
    ///         a compile-time error post-fix; this test asserts the field is GONE by
    ///         attempting a low-level call to its getter selector and expecting the call
    ///         to revert (no matching function).
    ///
    ///         Why a low-level probe rather than a compile-time guard: a regression that
    ///         re-adds the field in a future PR would silently re-introduce the
    ///         staleness; this test makes that regression observable as a test failure
    ///         (the call would succeed and return data) without requiring the test itself
    ///         to be edited.
    function test_AuditH2_VaultHasNoStoredOracleField() public view {
        // keccak256("oracle()") first 4 bytes
        bytes4 oracleSel = bytes4(keccak256("oracle()"));
        (bool ok, bytes memory data) = address(vault).staticcall(abi.encodeWithSelector(oracleSel));
        // Solidity's auto-generated getter would return 32 bytes (an address). A non-existent
        // function on a contract without a fallback returns ok=false (the EVM reverts).
        assertFalse(
            ok && data.length >= 32,
            "H-2 regression: SeasonVault.oracle() responded - stored field re-introduced"
        );
    }

    /// @notice Multi-rotation: rotate A → B → C and assert A and B both lose authority while
    ///         C has it. Catches a regression where the live-read accidentally caches
    ///         (reading on construction and pinning to that value).
    function test_AuditH2_MultipleRotationsAllPropagate() public {
        address oracleC = address(0xC3C3);

        launcher.setOracle(oracleB);
        launcher.setOracle(oracleC);

        address[] memory empty = new address[](0);
        uint256[] memory emptyOuts = new uint256[](0);

        vm.prank(oracleA);
        vm.expectRevert(SeasonVault.NotOracle.selector);
        vault.processFilterEvent(empty, emptyOuts);

        vm.prank(oracleB);
        vm.expectRevert(SeasonVault.NotOracle.selector);
        vault.processFilterEvent(empty, emptyOuts);

        vm.prank(oracleC);
        vm.expectRevert(SeasonVault.EmptyEvent.selector);
        vault.processFilterEvent(empty, emptyOuts);
    }
}
