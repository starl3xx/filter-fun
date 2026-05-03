// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BonusDistributor} from "../src/BonusDistributor.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MiniMerkle} from "./utils/MiniMerkle.sol";

contract BonusDistributorTest is Test {
    MockWETH weth;
    BonusDistributor bonus;

    address launcher = address(0xAAAA);
    address oracle = address(0xBBBB);
    address vault = address(0xCCCC);
    address winnerToken = address(0xDEAD);

    address aliceUser = address(0xA1);
    address bobUser = address(0xB2);

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(launcher, address(weth), oracle);

        // Vault prepares to fund.
        weth.mint(vault, 1 ether);
        vm.prank(vault);
        weth.approve(address(bonus), 1 ether);
    }

    function _fund(uint256 unlockTime) internal {
        vm.prank(vault);
        bonus.fundBonus(1, winnerToken, unlockTime, 1 ether);
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
        vm.expectRevert(BonusDistributor.NotYetUnlocked.selector);
        bonus.postRoot(1, bytes32(uint256(1)));

        vm.warp(block.timestamp + 13 days);

        bytes32 leafA = keccak256(abi.encodePacked(aliceUser, uint256(0.6 ether)));
        bytes32 leafB = keccak256(abi.encodePacked(bobUser, uint256(0.4 ether)));
        _postRoot(0.6 ether, 0.4 ether);

        bytes32[2] memory leaves = [leafA, leafB];

        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(aliceUser);
        bonus.claim(1, 0.6 ether, proofA);
        assertEq(weth.balanceOf(aliceUser), 0.6 ether);

        bytes32[] memory proofB = MiniMerkle.proofForTwo(leaves, 1);
        vm.prank(bobUser);
        bonus.claim(1, 0.4 ether, proofB);
        assertEq(weth.balanceOf(bobUser), 0.4 ether);

        assertEq(weth.balanceOf(address(bonus)), 0);
    }

    function test_BadProofReverts() public {
        _fund(block.timestamp);
        _postRoot(0.6 ether, 0.4 ether);
        bytes32[] memory bad = new bytes32[](1);
        bad[0] = bytes32(uint256(0xDEADBEEF));
        vm.prank(aliceUser);
        vm.expectRevert(BonusDistributor.InvalidProof.selector);
        bonus.claim(1, 0.6 ether, bad);
    }

    function test_DoubleClaimReverts() public {
        _fund(block.timestamp);
        bytes32 leafA = keccak256(abi.encodePacked(aliceUser, uint256(0.6 ether)));
        bytes32 leafB = keccak256(abi.encodePacked(bobUser, uint256(0.4 ether)));
        _postRoot(0.6 ether, 0.4 ether);
        bytes32[2] memory leaves = [leafA, leafB];
        bytes32[] memory proofA = MiniMerkle.proofForTwo(leaves, 0);
        vm.prank(aliceUser);
        bonus.claim(1, 0.6 ether, proofA);
        vm.prank(aliceUser);
        vm.expectRevert(BonusDistributor.AlreadyClaimed.selector);
        bonus.claim(1, 0.6 ether, proofA);
    }

    function test_DoubleFundReverts() public {
        _fund(block.timestamp);
        weth.mint(vault, 0.1 ether);
        vm.prank(vault);
        weth.approve(address(bonus), 0.1 ether);
        vm.prank(vault);
        vm.expectRevert(BonusDistributor.AlreadyFunded.selector);
        bonus.fundBonus(1, winnerToken, block.timestamp + 14 days, 0.1 ether);
    }
}
