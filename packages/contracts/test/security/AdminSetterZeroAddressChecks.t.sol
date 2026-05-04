// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault} from "../../src/TournamentVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";

/// @title AdminSetterZeroAddressChecks -- Audit Finding H-4 (Phase 1, 2026-05-01)
/// @notice The Phase-1 audit (`audit/2026-05-PHASE-1-AUDIT/contracts.md` High #4) flagged
///         that several `FilterLauncher` admin setters and the constructor accepted
///         `address(0)` without revert. The blast radius is operational rather than
///         exploit-grade — a fat-fingered `setOracle(0)` would brick every existing
///         per-season vault on the very next call (per H-2 the live-read picks up the
///         zero immediately) — but the spec line is explicit: every admin-setter must
///         fail closed on zero so the ops team gets a loud revert at write-time rather
///         than discovering a bricked deployment at use-time.
///
///         Surface covered:
///           - constructor(oracle_, treasury_, mechanics_, bonusDistributor_, weth_)
///           - setOracle(address)
///           - setFactory(IFilterFactory)
///           - setPolManager(IPOLManager) — was using a string `require`; normalised here
///             to `revert ZeroAddress()` for revert-selector consistency.
///
///         `setForfeitRecipient` already has the check (since launch); included here so
///         a regression that drops it surfaces in the same suite.
///
///         Test outcome contract:
///           - Pre-fix: constructor accepts zeros (no revert), setOracle/setFactory accept
///             zeros silently. setPolManager reverts but with a string error (different
///             selector than the rest of the surface).
///           - Post-fix: every test in this suite PASSES.
contract AdminSetterZeroAddressChecksTest is Test {
    FilterLauncher launcher;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0xD15C), address(weth), oracle);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
    }

    // ============================================================ Constructor

    function test_AuditH4_ConstructorRevertsOnZeroOracle() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(
            owner, address(0), treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
    }

    function test_AuditH4_ConstructorRevertsOnZeroTreasury() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(owner, oracle, address(0), mechanics, IBonusFunding(address(bonus)), address(weth));
    }

    function test_AuditH4_ConstructorRevertsOnZeroMechanics() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(owner, oracle, treasury, address(0), IBonusFunding(address(bonus)), address(weth));
    }

    function test_AuditH4_ConstructorRevertsOnZeroBonusDistributor() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(owner, oracle, treasury, mechanics, IBonusFunding(address(0)), address(weth));
    }

    function test_AuditH4_ConstructorRevertsOnZeroWeth() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(0));
    }

    /// @notice Sanity: a constructor with all-non-zero deps succeeds. Pinned so a
    ///         regression that breaks the happy path also lights up here.
    function test_AuditH4_ConstructorAcceptsValidAddresses() public {
        FilterLauncher l = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        assertEq(l.oracle(), oracle);
        assertEq(l.treasury(), treasury);
        assertEq(l.mechanics(), mechanics);
        assertEq(address(l.bonusDistributor()), address(bonus));
        assertEq(l.weth(), address(weth));
    }

    // ============================================================ setOracle

    function test_AuditH4_SetOracleRevertsOnZero() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.setOracle(address(0));
    }

    function test_AuditH4_SetOracleAcceptsValidAddress() public {
        address newOracle = address(0xC4F4);
        launcher.setOracle(newOracle);
        assertEq(launcher.oracle(), newOracle);
    }

    // ============================================================ setFactory

    function test_AuditH4_SetFactoryRevertsOnZero() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.setFactory(IFilterFactory(address(0)));
    }

    // ============================================================ setPolManager

    function test_AuditH4_SetPolManagerRevertsOnZeroWithCustomError() public {
        // Pre-fix this used a string `require("zero polManager")`; post-fix the revert is
        // the same selector as the rest of the admin-setter surface so an off-chain
        // alerter can match a single selector across the launcher's writes.
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.setPolManager(IPOLManager(address(0)));
    }

    // `setForfeitRecipient` was removed when `forfeitRecipient` became immutable (Epic 1.15a
    // — EIP-170 size budget). The constructor sets it to `treasury_`; rotation is no longer
    // supported in-contract.

    // ============================================================ setTournament

    /// @notice Audit: bugbot M PR #88. The one-shot `setTournament` guard MUST also
    ///         reject zero `registry_` — otherwise a first call with zero leaves the
    ///         storage slot at `address(0)`, and the AlreadySet sentinel fails to fire
    ///         on a second call. This would let an attacker (or a confused operator)
    ///         silently re-wire the tournament addresses post-deploy.
    function test_BugbotPR88_SetTournamentRejectsZeroRegistry() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.setTournament(TournamentRegistry(address(0)), TournamentVault(payable(address(0xBEEF))));
        // Sanity: storage stays at zero, so a follow-up call with valid args still works
        // (the one-shot guard hasn't been tripped because the bad call reverted).
        assertEq(address(launcher.tournamentRegistry()), address(0));
    }

    /// @notice Audit: bugbot L PR #88. Mirror of the registry check for `vault_`.
    ///         A zero vault would permanently brick `TournamentRegistry`'s
    ///         `onlyTournamentVault`-gated entry points (no caller can match
    ///         `address(0)`), and the one-shot `AlreadySet` guard blocks re-wiring.
    function test_BugbotPR88_SetTournamentRejectsZeroVault() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.setTournament(TournamentRegistry(address(0xDEAD)), TournamentVault(payable(address(0))));
    }

    /// @notice Audit: bugbot M PR #88. `startSeason` MUST refuse to deploy a
    ///         `SeasonVault` if `tournamentRegistry` is unset — baking
    ///         `address(0)` into the vault's `submitWinner` / `processFilterEvent`
    ///         paths would permanently brick those flows for that season.
    function test_BugbotPR88_StartSeasonRejectsUnsetTournamentRegistry() public {
        // Wire polManager (else `PolManagerUnset` fires first) but skip `setTournament`.
        launcher.setPolManager(IPOLManager(address(0xF000)));
        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.startSeason();
    }
}
