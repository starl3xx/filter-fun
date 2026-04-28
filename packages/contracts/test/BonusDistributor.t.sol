// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BonusDistributor} from "../src/BonusDistributor.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MiniMerkle} from "./utils/MiniMerkle.sol";

contract BonusDistributorTest is Test {
    MockUSDC usdc;
    BonusDistributor bonus;

    address launcher = address(0xAAAA);
    address oracle = address(0xBBBB);
    address vault = address(0xCCCC);
    address winnerToken = address(0xDEAD);

    address aliceUser = address(0xA1);
    address bobUser = address(0xB2);

    function setUp() public {
        usdc = new MockUSDC();
        bonus = new BonusDistributor(launcher, address(usdc), oracle);

        // Vault prepares to fund.
        usdc.mint(vault, 1000e6);
        vm.prank(vault);
        usdc.approve(address(bonus), 1000e6);
    }

    function _fund(uint256 unlockTime) internal {
        vm.prank(vault);
        bonus.fundBonus(1, winnerToken, unlockTime, 1000e6);
    }

    function _postRoot(uint256 amountA, uint256 amountB) internal returns (bytes32) {
        bytes32 leafA = keccak256(abi.encodePacked(aliceUser, amountA));
        bytes32 leafB = keccak256(abi.encodePacked(bobUser, amountB));
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafB);
        vm.prank(oracle);
        bonus.postRoot(1, root);
        return root;
    }

    function test_HappyPath() public {
        _fund(block.timestamp + 14 days);

        // Cannot post root before unlock.
        vm.warp(block.timestamp + 1 days);
        vm.prank(oracle);
        vm.expectRevert(BonusDistributor.NotUnlocked.selector);
        bonus.postRoot(1, bytes32(uint256(1)));

        vm.warp(block.timestamp + 13 days);

        bytes32 leafA = keccak256(abi.encodePacked(aliceUser, uint256(600e6)));
        bytes32 leafB = keccak256(abi.encodePacked(bobUser, uint256(400e6)));
        _postRoot(600e6, 400e6);

        bytes32[2] memory leaves = [leafA, leafB];

        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(aliceUser);
        bonus.claim(1, 600e6, proofA);
        assertEq(usdc.balanceOf(aliceUser), 600e6);

        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(bobUser);
        bonus.claim(1, 400e6, proofB);
        assertEq(usdc.balanceOf(bobUser), 400e6);

        assertEq(usdc.balanceOf(address(bonus)), 0);
    }

    function test_BadProofReverts() public {
        _fund(block.timestamp);
        _postRoot(600e6, 400e6);
        bytes32[] memory bad = new bytes32[](1);
        bad[0] = bytes32(uint256(0xDEADBEEF));
        vm.prank(aliceUser);
        vm.expectRevert(BonusDistributor.InvalidProof.selector);
        bonus.claim(1, 600e6, bad);
    }

    function test_DoubleClaimReverts() public {
        _fund(block.timestamp);
        bytes32 leafA = keccak256(abi.encodePacked(aliceUser, uint256(600e6)));
        bytes32 leafB = keccak256(abi.encodePacked(bobUser, uint256(400e6)));
        _postRoot(600e6, 400e6);
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(aliceUser);
        bonus.claim(1, 600e6, proofA);
        vm.prank(aliceUser);
        vm.expectRevert(BonusDistributor.AlreadyClaimed.selector);
        bonus.claim(1, 600e6, proofA);
    }

    function test_DoubleFundReverts() public {
        _fund(block.timestamp);
        usdc.mint(vault, 100e6);
        vm.prank(vault);
        usdc.approve(address(bonus), 100e6);
        vm.prank(vault);
        vm.expectRevert(BonusDistributor.AlreadyFunded.selector);
        bonus.fundBonus(1, winnerToken, block.timestamp + 14 days, 100e6);
    }
}
