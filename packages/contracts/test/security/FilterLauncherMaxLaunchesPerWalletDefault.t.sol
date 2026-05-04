// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault} from "../../src/TournamentVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title FilterLauncherMaxLaunchesPerWalletDefaultTest -- Audit Finding C-2 (descoped)
/// @notice The Phase-1 audit (`audit/2026-05-PHASE-1-AUDIT/contracts.md` Critical #2) flagged
///         a per-wallet-cap-default-drift bug on the pre-§46 launcher: the configurable
///         `maxLaunchesPerWallet` storage slot defaulted to `2`, masked only by the deploy
///         script's `setMaxLaunchesPerWallet(1)` override. Spec §46 deferred-activation
///         removed the configurable knob entirely — the per-wallet cap is now enforced
///         STRUCTURALLY by `LaunchEscrow.escrows[seasonId][creator].amount != 0`. There is
///         no env var, no setter, and no constructor-default to drift; a creator can only
///         hold one reservation per season because the escrow refuses to record a second.
///
///         This suite is preserved (rather than deleted) because the C-2 finding is in the
///         audit catalogue with this filename as its on-chain regression test. Going forward
///         it asserts the structural property: a second `reserve` from the same wallet in
///         the same season reverts `AlreadyReserved`, with no operator override needed.
contract FilterLauncherMaxLaunchesPerWalletDefaultTest is Test {
    FilterLauncher launcher;
    MockFilterFactory factory;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polManager = address(0xF000);
    address aliceCreator = address(0xA1);

    receive() external payable {}

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);

        // Direct constructor — NO deploy-script override. The structural per-wallet cap
        // ships out-of-the-box; if a future refactor undid this it would surface here.
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        launcher.setPolManager(IPOLManager(polManager));
        factory = new MockFilterFactory(address(launcher), address(weth));
        launcher.setFactory(IFilterFactory(address(factory)));
        // Tournament wire required since `startSeason` zero-checks the registry
        // (audit: bugbot M PR #88).
        launcher.setTournament(TournamentRegistry(address(0xDEAD)), TournamentVault(payable(address(0xBEEF))));

        vm.deal(aliceCreator, 100 ether);
    }

    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether;
        uint256 m = 12;
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    /// @notice Audit C-2 (post-§46 form): a second reservation from the same wallet in the
    ///         same season MUST revert `AlreadyReserved` without any owner intervention.
    function test_AuditC2_SecondReservationSameWalletRevertsByDefault() public {
        vm.prank(oracle);
        launcher.startSeason();

        vm.startPrank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("AAA", "ipfs://meta");
        vm.expectRevert(FilterLauncher.AlreadyReserved.selector);
        launcher.reserve{value: _slotCost(1)}("BBB", "ipfs://meta");
        vm.stopPrank();
    }
}
