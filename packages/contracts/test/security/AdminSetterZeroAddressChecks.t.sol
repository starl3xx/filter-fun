// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {FilterClubPass} from "../../src/FilterClubPass.sol";
import {IFilterClubPass} from "../../src/interfaces/IFilterClubPass.sol";
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
///           - constructor(oracle_, treasury_, mechanics_, bonusDistributor_, weth_, clubPass_)
///           - setOracle(address)
///           - wire(factory_, polManager_, registry_, vault_) — Epic 2.6 consolidated the
///             three one-shot setters (setFactory / setPolManager / setTournament) into a
///             single atomic entry point; the per-arg zero checks and the AlreadySet
///             sentinel carry over here.
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
    FilterClubPass clubPass;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0xD15C), address(weth), oracle);
        clubPass = new FilterClubPass(owner, treasury, "ipfs://club/", 250, 0.05 ether, 5);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth), clubPass
        );
        clubPass.setLauncher(address(launcher));
    }

    // ============================================================ Constructor

    function test_AuditH4_ConstructorRevertsOnZeroOracle() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(
            owner, address(0), treasury, mechanics, IBonusFunding(address(bonus)), address(weth), clubPass
        );
    }

    function test_AuditH4_ConstructorRevertsOnZeroTreasury() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(
            owner, oracle, address(0), mechanics, IBonusFunding(address(bonus)), address(weth), clubPass
        );
    }

    function test_AuditH4_ConstructorRevertsOnZeroMechanics() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(
            owner, oracle, treasury, address(0), IBonusFunding(address(bonus)), address(weth), clubPass
        );
    }

    function test_AuditH4_ConstructorRevertsOnZeroBonusDistributor() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(0)), address(weth), clubPass
        );
    }

    function test_AuditH4_ConstructorRevertsOnZeroWeth() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(0), clubPass
        );
    }

    /// @notice Epic 2.6: the Filter Club pass is a constructor-injected immutable — a zero
    ///         pass would brick the `reserve` credit branch at first zero-value call, so it
    ///         joins the H-4 zero-check surface.
    function test_AuditH4_ConstructorRevertsOnZeroClubPass() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        new FilterLauncher(
            owner,
            oracle,
            treasury,
            mechanics,
            IBonusFunding(address(bonus)),
            address(weth),
            IFilterClubPass(address(0))
        );
    }

    /// @notice Sanity: a constructor with all-non-zero deps succeeds. Pinned so a
    ///         regression that breaks the happy path also lights up here.
    function test_AuditH4_ConstructorAcceptsValidAddresses() public {
        FilterLauncher l = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth), clubPass
        );
        assertEq(l.oracle(), oracle);
        assertEq(l.treasury(), treasury);
        assertEq(l.mechanics(), mechanics);
        assertEq(address(l.bonusDistributor()), address(bonus));
        assertEq(l.weth(), address(weth));
        assertEq(address(l.clubPass()), address(clubPass));
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

    // ============================================================ wire
    //
    // Epic 2.6 consolidated setFactory / setPolManager / setTournament into a single
    // atomic `wire(factory_, polManager_, registry_, vault_)`. The zero-address gates
    // are preserved per-arg (bugbot M+L PR #88: a zero in any slot would either bypass
    // the AlreadySet sentinel — which keys off `factory` — or permanently brick that
    // path with the one-shot guard blocking a re-wire). Dummy non-zero addresses are
    // fine here: this suite never dereferences the wired contracts.

    function test_AuditH4_WireRevertsOnZeroFactory() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.wire(
            IFilterFactory(address(0)),
            IPOLManager(address(0xF000)),
            TournamentRegistry(address(0xDEAD)),
            TournamentVault(payable(address(0xBEEF)))
        );
        // Sanity: storage stays at zero, so a follow-up call with valid args still works
        // (the one-shot guard hasn't been tripped because the bad call reverted).
        assertEq(address(launcher.factory()), address(0));
    }

    function test_AuditH4_WireRevertsOnZeroPolManager() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.wire(
            IFilterFactory(address(0xFAC7)),
            IPOLManager(address(0)),
            TournamentRegistry(address(0xDEAD)),
            TournamentVault(payable(address(0xBEEF)))
        );
    }

    /// @notice Audit: bugbot M PR #88 (carried over from `setTournament`). The one-shot
    ///         guard MUST also reject zero `registry_` — otherwise a first call with zero
    ///         leaves the storage slot at `address(0)` and later season starts would bake
    ///         it into fresh SeasonVaults.
    function test_BugbotPR88_WireRejectsZeroRegistry() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.wire(
            IFilterFactory(address(0xFAC7)),
            IPOLManager(address(0xF000)),
            TournamentRegistry(address(0)),
            TournamentVault(payable(address(0xBEEF)))
        );
        assertEq(address(launcher.tournamentRegistry()), address(0));
    }

    /// @notice Audit: bugbot L PR #88 (carried over). Mirror of the registry check for
    ///         `vault_`. A zero vault would permanently brick `TournamentRegistry`'s
    ///         `onlyTournamentVault`-gated entry points, and the one-shot `AlreadySet`
    ///         guard blocks re-wiring.
    function test_BugbotPR88_WireRejectsZeroVault() public {
        vm.expectRevert(FilterLauncher.ZeroAddress.selector);
        launcher.wire(
            IFilterFactory(address(0xFAC7)),
            IPOLManager(address(0xF000)),
            TournamentRegistry(address(0xDEAD)),
            TournamentVault(payable(address(0)))
        );
    }

    /// @notice Happy path: one wire call assigns all four slots atomically.
    function test_WireAssignsAllFourSlots() public {
        _wireWithDummies();
        assertEq(address(launcher.factory()), address(0xFAC7));
        assertEq(address(launcher.polManager()), address(0xF000));
        assertEq(address(launcher.tournamentRegistry()), address(0xDEAD));
        assertEq(address(launcher.tournamentVault()), address(0xBEEF));
    }

    /// @notice One-shot: a second wire reverts `AlreadySet` (sentinel keys off `factory`).
    function test_WireSecondCallRevertsAlreadySet() public {
        _wireWithDummies();
        vm.expectRevert(FilterLauncher.AlreadySet.selector);
        _wireWithDummies();
    }

    /// @notice Owner gate: a non-owner cannot wire.
    function test_WireRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        launcher.wire(
            IFilterFactory(address(0xFAC7)),
            IPOLManager(address(0xF000)),
            TournamentRegistry(address(0xDEAD)),
            TournamentVault(payable(address(0xBEEF)))
        );
    }

    // `setForfeitRecipient` was removed when `forfeitRecipient` became immutable (Epic 1.15a
    // — EIP-170 size budget). The constructor sets it to `treasury_`; rotation is no longer
    // supported in-contract.

    /// @notice Audit: bugbot M PR #88 (post-Epic-2.6 form). `startSeason` MUST refuse to
    ///         run on an unwired launcher. `wire` is atomic, so "polManager set but
    ///         tournamentRegistry unset" is no longer reachable — the unwired launcher
    ///         trips the first gate (`PolManagerUnset`); the registry zero-check remains
    ///         in `startSeason` as defense-in-depth.
    function test_BugbotPR88_StartSeasonRejectsUnwiredLauncher() public {
        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.PolManagerUnset.selector);
        launcher.startSeason();
    }

    function _wireWithDummies() internal {
        launcher.wire(
            IFilterFactory(address(0xFAC7)),
            IPOLManager(address(0xF000)),
            TournamentRegistry(address(0xDEAD)),
            TournamentVault(payable(address(0xBEEF)))
        );
    }
}
