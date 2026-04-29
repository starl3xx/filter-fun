// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {POLVault} from "../src/POLVault.sol";
import {MintableERC20} from "./mocks/MintableERC20.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";

/// @notice Focused tests for POLVault's auth model and one-shot deposit flag. The
///         high/medium severity bugbot findings on PR #22 motivate every test here:
///         (1) deposits must be gated to the launcher's registered SeasonVault — otherwise
///         anyone can latch the per-season `deposited` flag and DoS settlement;
///         (2) the latch must be a separate bool, not a numeric sentinel — a zero-amount
///         legitimate deposit otherwise leaves the guard transparent.
contract POLVaultTest is Test {
    POLVault polVault;
    MockLauncherView launcher;
    MintableERC20 winnerToken;

    address owner = address(this);
    address newOwner = makeAddr("newOwner");
    address realVault = makeAddr("realVault");
    address attacker = makeAddr("attacker");

    function setUp() public {
        launcher = new MockLauncherView();
        polVault = new POLVault(owner);
        polVault.setLauncher(address(launcher));
        winnerToken = new MintableERC20("Winner", "WIN");
    }

    // ============================================================ setLauncher

    function test_SetLauncher_OneShot() public {
        POLVault v = new POLVault(owner);
        v.setLauncher(address(launcher));
        vm.expectRevert(POLVault.LauncherAlreadySet.selector);
        v.setLauncher(address(0xBEEF));
    }

    function test_SetLauncher_OnlyOwner() public {
        POLVault v = new POLVault(owner);
        vm.prank(attacker);
        vm.expectRevert();
        v.setLauncher(address(launcher));
    }

    function test_SetLauncher_RejectsZero() public {
        POLVault v = new POLVault(owner);
        vm.expectRevert(POLVault.ZeroAddress.selector);
        v.setLauncher(address(0));
    }

    function test_DepositRevertsBeforeLauncherSet() public {
        POLVault v = new POLVault(owner);
        vm.prank(realVault);
        vm.expectRevert(POLVault.LauncherNotSet.selector);
        v.deposit(1, address(winnerToken), 0);
    }

    // ============================================================ deposit auth

    /// @notice The headline bugbot finding: an arbitrary attacker must NOT be able to call
    ///         `deposit` and latch the `deposited` flag, which would make the legitimate
    ///         SeasonVault's `submitWinner` revert with `AlreadyDeposited` and lock settlement.
    function test_Deposit_RevertsForUnregisteredCaller() public {
        launcher.setVault(1, realVault);
        vm.prank(attacker);
        vm.expectRevert(POLVault.NotRegisteredVault.selector);
        polVault.deposit(1, address(winnerToken), 0);
        // Crucial: the failed call must not have latched the flag.
        assertFalse(polVault.deposited(1));
    }

    /// @notice The legitimate SeasonVault for that season can deposit, and the deposit is
    ///         tracked correctly. (Zero amount path — exercises the bool flag without ERC-20.)
    function test_Deposit_RegisteredVaultZeroAmount() public {
        launcher.setVault(1, realVault);
        vm.prank(realVault);
        polVault.deposit(1, address(winnerToken), 0);
        assertTrue(polVault.deposited(1));
        assertEq(polVault.seasonDeposit(1), 0);
        assertEq(polVault.seasonWinner(1), address(winnerToken));
    }

    function test_Deposit_RegisteredVaultWithTokens() public {
        launcher.setVault(1, realVault);
        winnerToken.mint(realVault, 100 ether);
        vm.prank(realVault);
        winnerToken.approve(address(polVault), 100 ether);

        vm.prank(realVault);
        polVault.deposit(1, address(winnerToken), 100 ether);

        assertEq(polVault.seasonDeposit(1), 100 ether);
        assertEq(winnerToken.balanceOf(address(polVault)), 100 ether);
        assertTrue(polVault.deposited(1));
    }

    /// @notice The medium-severity finding: a legitimate zero-amount deposit must still
    ///         latch the flag — otherwise a second, real deposit slips through the
    ///         numeric guard and double-credits the season.
    function test_Deposit_ZeroAmountStillLatches() public {
        launcher.setVault(1, realVault);

        // First deposit with zero amount.
        vm.prank(realVault);
        polVault.deposit(1, address(winnerToken), 0);

        // Second, real deposit must revert.
        winnerToken.mint(realVault, 100 ether);
        vm.prank(realVault);
        winnerToken.approve(address(polVault), 100 ether);

        vm.prank(realVault);
        vm.expectRevert(POLVault.AlreadyDeposited.selector);
        polVault.deposit(1, address(winnerToken), 100 ether);
    }

    function test_Deposit_AlreadyDepositedReverts() public {
        launcher.setVault(1, realVault);
        winnerToken.mint(realVault, 200 ether);
        vm.prank(realVault);
        winnerToken.approve(address(polVault), 200 ether);

        vm.prank(realVault);
        polVault.deposit(1, address(winnerToken), 100 ether);

        vm.prank(realVault);
        vm.expectRevert(POLVault.AlreadyDeposited.selector);
        polVault.deposit(1, address(winnerToken), 100 ether);
    }

    /// @notice Different seasons have independent flags — one season's deposit doesn't
    ///         block another.
    function test_Deposit_PerSeasonIndependent() public {
        address vault1 = makeAddr("vault1");
        address vault2 = makeAddr("vault2");
        launcher.setVault(1, vault1);
        launcher.setVault(2, vault2);

        vm.prank(vault1);
        polVault.deposit(1, address(winnerToken), 0);

        vm.prank(vault2);
        polVault.deposit(2, address(winnerToken), 0);

        assertTrue(polVault.deposited(1));
        assertTrue(polVault.deposited(2));
    }

    // ============================================================ withdraw

    function test_Withdraw_OnlyOwner() public {
        winnerToken.mint(address(polVault), 50 ether);
        vm.prank(attacker);
        vm.expectRevert();
        polVault.withdraw(address(winnerToken), attacker, 50 ether);
    }

    function test_Withdraw_OwnerCanRescue() public {
        winnerToken.mint(address(polVault), 50 ether);
        polVault.withdraw(address(winnerToken), newOwner, 50 ether);
        assertEq(winnerToken.balanceOf(newOwner), 50 ether);
    }
}
