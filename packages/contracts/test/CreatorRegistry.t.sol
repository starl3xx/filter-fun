// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CreatorRegistry} from "../src/CreatorRegistry.sol";

contract CreatorRegistryTest is Test {
    CreatorRegistry registry;
    address launcher = makeAddr("launcher");
    address attacker = makeAddr("attacker");
    address tokenA = makeAddr("tokenA");
    address creatorA = makeAddr("creatorA");

    function setUp() public {
        registry = new CreatorRegistry(launcher);
    }

    function test_OnlyLauncher() public {
        vm.prank(attacker);
        vm.expectRevert(CreatorRegistry.NotLauncher.selector);
        registry.register(tokenA, creatorA);
    }

    function test_RejectsZeroToken() public {
        vm.prank(launcher);
        vm.expectRevert(CreatorRegistry.ZeroToken.selector);
        registry.register(address(0), creatorA);
    }

    function test_RejectsZeroCreator() public {
        vm.prank(launcher);
        vm.expectRevert(CreatorRegistry.ZeroCreator.selector);
        registry.register(tokenA, address(0));
    }

    function test_HappyPath() public {
        vm.warp(1_700_000_000);
        vm.prank(launcher);
        registry.register(tokenA, creatorA);
        assertEq(registry.creatorOf(tokenA), creatorA);
        assertEq(registry.launchedAt(tokenA), 1_700_000_000);
        assertTrue(registry.isRegistered(tokenA));
    }

    function test_RejectsDoubleRegister() public {
        vm.prank(launcher);
        registry.register(tokenA, creatorA);
        vm.prank(launcher);
        vm.expectRevert(CreatorRegistry.AlreadyRegistered.selector);
        registry.register(tokenA, creatorA);
    }

    function test_IsRegistered() public {
        assertFalse(registry.isRegistered(tokenA));
        vm.prank(launcher);
        registry.register(tokenA, creatorA);
        assertTrue(registry.isRegistered(tokenA));
    }
}
