// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CreatorCommitments} from "../src/CreatorCommitments.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {FilterToken} from "../src/FilterToken.sol";

/// @notice Coverage for the Epic 1.13 bag-lock primitive.
///
///         Two surfaces under test:
///         1. CreatorCommitments standalone — auth, monotonicity, lock-forever, reentrancy.
///         2. FilterToken transfer gating against a real `commitments` instance — proves the
///            FROM-side check fires on transfer/transferFrom and that pre-commit balances on
///            other wallets escape the gate (false-trust risk that the UI must surface).
///
///         Audit-relevance: this test set is the primary structural-correctness bar for the
///         bag-lock contract. Mainnet activation is gated on Epic 2.3 audit; these tests are
///         the artifacts that audit reviews.
contract CreatorCommitmentsTest is Test {
    CreatorRegistry registry;
    CreatorCommitments commitments;

    address launcher = makeAddr("launcher");
    address creator = makeAddr("creator");
    address stranger = makeAddr("stranger");
    address tokenA = makeAddr("tokenA");
    address tokenB = makeAddr("tokenB");

    function setUp() public {
        registry = new CreatorRegistry(launcher);
        commitments = new CreatorCommitments(registry);
        vm.prank(launcher);
        registry.register(tokenA, creator);
    }

    // ============================================================ Default state

    function test_NoLockByDefault() public view {
        assertFalse(commitments.isLocked(creator, tokenA));
        assertEq(commitments.unlockOf(creator, tokenA), 0);
    }

    // ============================================================ Happy-path commit

    function test_Commit_HappyPath() public {
        uint256 lockUntil = block.timestamp + 30 days;
        vm.expectEmit(true, true, false, true);
        emit CreatorCommitments.Committed(creator, tokenA, lockUntil, 0);
        vm.prank(creator);
        commitments.commit(tokenA, lockUntil);

        assertTrue(commitments.isLocked(creator, tokenA));
        assertEq(commitments.unlockOf(creator, tokenA), lockUntil);
    }

    function test_Commit_ExtendSucceeds() public {
        uint256 first = block.timestamp + 7 days;
        uint256 second = block.timestamp + 30 days;

        vm.prank(creator);
        commitments.commit(tokenA, first);

        vm.expectEmit(true, true, false, true);
        emit CreatorCommitments.Committed(creator, tokenA, second, first);
        vm.prank(creator);
        commitments.commit(tokenA, second);

        assertEq(commitments.unlockOf(creator, tokenA), second);
    }

    function test_Commit_LockExpiresUnlocksTransfer() public {
        uint256 lockUntil = block.timestamp + 1 days;
        vm.prank(creator);
        commitments.commit(tokenA, lockUntil);

        assertTrue(commitments.isLocked(creator, tokenA));
        // Symmetric edge: at the unlock timestamp the lock is over (strict `<` in isLocked).
        vm.warp(lockUntil);
        assertFalse(commitments.isLocked(creator, tokenA));
    }

    function test_Commit_StillLockedOneSecondBeforeUnlock() public {
        uint256 lockUntil = block.timestamp + 1 days;
        vm.prank(creator);
        commitments.commit(tokenA, lockUntil);

        vm.warp(lockUntil - 1);
        assertTrue(commitments.isLocked(creator, tokenA));
    }

    function test_Commit_LockForever() public {
        // type(uint256).max is explicitly allowed and documented as "permanent lock".
        vm.prank(creator);
        commitments.commit(tokenA, type(uint256).max);

        // Far-future warp must keep the lock active. Stay below uint256 max so block.timestamp
        // doesn't overflow the comparison and accidentally pass.
        vm.warp(block.timestamp + 100 * 365 days);
        assertTrue(commitments.isLocked(creator, tokenA));
        assertEq(commitments.unlockOf(creator, tokenA), type(uint256).max);
    }

    // ============================================================ Auth reverts

    function test_Commit_RevertsIfNotCreator() public {
        vm.prank(stranger);
        vm.expectRevert(CreatorCommitments.NotCreator.selector);
        commitments.commit(tokenA, block.timestamp + 1 days);
    }

    function test_Commit_RevertsIfTokenNotRegistered() public {
        vm.prank(creator);
        vm.expectRevert(CreatorCommitments.TokenNotRegistered.selector);
        commitments.commit(tokenB, block.timestamp + 1 days);
    }

    function test_Commit_AdminTransferDoesNotMoveLockAuth() public {
        // Admin transfer moves the *control* of recipient/metadata. The bag-lock is a personal
        // commitment by the original launcher and must NOT follow the admin role — the
        // pending+accepted admin should still get NotCreator on commit().
        address newAdmin = makeAddr("newAdmin");
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        vm.prank(newAdmin);
        registry.acceptAdmin(tokenA);

        vm.prank(newAdmin);
        vm.expectRevert(CreatorCommitments.NotCreator.selector);
        commitments.commit(tokenA, block.timestamp + 1 days);

        // Original creator can still commit.
        vm.prank(creator);
        commitments.commit(tokenA, block.timestamp + 1 days);
        assertTrue(commitments.isLocked(creator, tokenA));
    }

    // ============================================================ Bound reverts

    function test_Commit_RevertsIfNotInFuture() public {
        vm.prank(creator);
        vm.expectRevert(CreatorCommitments.LockMustBeFuture.selector);
        commitments.commit(tokenA, block.timestamp);
    }

    function test_Commit_RevertsIfInPast() public {
        vm.warp(1000);
        vm.prank(creator);
        vm.expectRevert(CreatorCommitments.LockMustBeFuture.selector);
        commitments.commit(tokenA, 999);
    }

    function test_Commit_RevertsOnShorten() public {
        uint256 first = block.timestamp + 30 days;
        uint256 shorter = block.timestamp + 7 days;

        vm.prank(creator);
        commitments.commit(tokenA, first);

        vm.prank(creator);
        vm.expectRevert(CreatorCommitments.LockCannotShorten.selector);
        commitments.commit(tokenA, shorter);
    }

    function test_Commit_RevertsOnEqualExtension() public {
        // Strict-`>` invariant: re-committing the same timestamp is a no-op-equivalent that the
        // contract refuses, both to keep the indexer event stream clean and to make the
        // monotonicity rule unambiguous.
        uint256 lockUntil = block.timestamp + 30 days;
        vm.prank(creator);
        commitments.commit(tokenA, lockUntil);

        vm.prank(creator);
        vm.expectRevert(CreatorCommitments.LockCannotShorten.selector);
        commitments.commit(tokenA, lockUntil);
    }

    // ============================================================ Reentrancy guard

    /// @notice The guard is defensive — `commit` makes no external calls today, so there's no
    ///         way to trigger a reentrant entry from inside the contract. This test proves the
    ///         guard releases cleanly between back-to-back commits from the same contract
    ///         caller, mirroring the `test_GuardReleasesBetweenCalls` pattern in
    ///         `CreatorRegistryAdmin.t.sol`. If a future change introduces an external call
    ///         inside `commit` (e.g. an ERC-777-style hook) and removes the guard, this test
    ///         keeps passing — the safety net is the `nonReentrant` modifier on the source.
    ///         A real reentrancy probe would need to be added alongside that change.
    function test_Commit_GuardReleasesBetweenCalls() public {
        ContractCreator cc = new ContractCreator(commitments);
        address tokenC = makeAddr("tokenC");
        vm.prank(launcher);
        registry.register(tokenC, address(cc));

        cc.commitTwice(tokenC, block.timestamp + 7 days, block.timestamp + 30 days);
        assertEq(commitments.unlockOf(address(cc), tokenC), block.timestamp + 30 days);
    }

    // ============================================================ Token transfer gating

    /// @notice End-to-end against a real FilterToken: lock the creator's address, prove that
    ///         transfers from that address revert and transfers from other addresses go
    ///         through. This is the audit-grade gating test.
    function test_TransferGate_LockBlocksFromAddress() public {
        FilterToken token = _deployToken("alpha", "ALPHA", creator);
        // Move some tokens to the creator (factory holds the supply at construction; in the
        // real flow the locker pulls them out for LP — here we just transfer directly).
        token.transfer(creator, 1_000 ether);

        vm.prank(creator);
        commitments.commit(address(token), block.timestamp + 30 days);

        vm.prank(creator);
        vm.expectRevert();
        token.transfer(stranger, 1 ether);
    }

    function test_TransferGate_LockBlocksTransferFrom() public {
        FilterToken token = _deployToken("alpha", "ALPHA", creator);
        token.transfer(creator, 1_000 ether);

        vm.prank(creator);
        token.approve(stranger, type(uint256).max);
        vm.prank(creator);
        commitments.commit(address(token), block.timestamp + 30 days);

        vm.prank(stranger);
        vm.expectRevert();
        token.transferFrom(creator, stranger, 1 ether);
    }

    function test_TransferGate_OtherAddressesUnaffected() public {
        // Bug-bot regression target: the gate must only fire on the locked FROM, never on
        // other addresses' transfers. If the gate accidentally referenced `to` or `msg.sender`
        // this test would fail.
        FilterToken token = _deployToken("alpha", "ALPHA", creator);
        token.transfer(stranger, 1_000 ether);

        vm.prank(creator);
        commitments.commit(address(token), block.timestamp + 30 days);

        // Stranger isn't locked — transfer must succeed.
        address recipient = makeAddr("recipient");
        vm.prank(stranger);
        token.transfer(recipient, 100 ether);
        assertEq(token.balanceOf(recipient), 100 ether);
    }

    function test_TransferGate_PreCommitTransfersEscape() public {
        // The "false-trust" scenario the UI must surface: creator transfers half their bag to
        // wallet B BEFORE committing. After commit, wallet B can still freely transfer because
        // the gate is keyed off (creator, token), not the entire supply.
        FilterToken token = _deployToken("alpha", "ALPHA", creator);
        token.transfer(creator, 1_000 ether);

        address walletB = makeAddr("walletB");
        vm.prank(creator);
        token.transfer(walletB, 500 ether);

        // Now creator commits. WalletB still moves freely.
        vm.prank(creator);
        commitments.commit(address(token), block.timestamp + 30 days);

        address recipient = makeAddr("recipient");
        vm.prank(walletB);
        token.transfer(recipient, 100 ether);
        assertEq(token.balanceOf(recipient), 100 ether);

        // And creator's remaining bag is locked.
        vm.prank(creator);
        vm.expectRevert();
        token.transfer(recipient, 1 ether);
    }

    function test_TransferGate_UnlocksAfterExpiry() public {
        FilterToken token = _deployToken("alpha", "ALPHA", creator);
        token.transfer(creator, 1_000 ether);

        uint256 lockUntil = block.timestamp + 30 days;
        vm.prank(creator);
        commitments.commit(address(token), lockUntil);

        vm.warp(lockUntil);
        vm.prank(creator);
        token.transfer(stranger, 1 ether);
        assertEq(token.balanceOf(stranger), 1 ether);
    }

    function test_TransferGate_IncomingTransfersAllowed() public {
        // Lock applies to FROM only — incoming transfers (TO the locked address) must still
        // succeed. Otherwise creators couldn't accept fee revenue / tips while locked.
        FilterToken token = _deployToken("alpha", "ALPHA", creator);
        token.transfer(stranger, 1_000 ether);

        vm.prank(creator);
        commitments.commit(address(token), block.timestamp + 30 days);

        vm.prank(stranger);
        token.transfer(creator, 100 ether);
        assertEq(token.balanceOf(creator), 100 ether);
    }

    function test_TransferGate_MintAllowedDuringConstruction() public {
        // The very act of deploying a FilterToken mints supply to the factory (`mintTo` in
        // the constructor). That's `_update(0, mintTo, supply)` — the from==0 branch of the
        // gate must not consult `isLocked` (the address arg would be zero, but the principle
        // is what matters). This test just confirms construction succeeds at all and the
        // factory ends up with the supply.
        FilterToken token = _deployToken("alpha", "ALPHA", address(this));
        assertEq(token.balanceOf(address(this)), 1_000_000_000 ether);
    }

    // ============================================================ Helpers

    /// Deploys a FilterToken wired to this test's commitments instance and registers it
    /// with the registry under `creator_` as the creator-of-record.
    function _deployToken(string memory name, string memory symbol, address creator_)
        internal
        returns (FilterToken token)
    {
        token = new FilterToken(name, symbol, 1_000_000_000 ether, address(this), "ipfs://test", commitments);
        vm.prank(launcher);
        registry.register(address(token), creator_);
    }
}

/// @notice Verifies a contract — not just an EOA — can be the creator-of-record and drive
///         consecutive commits in a single tx. Mirrors `ContractAdmin` in the registry tests.
contract ContractCreator {
    CreatorCommitments public immutable commitments;

    constructor(CreatorCommitments commitments_) {
        commitments = commitments_;
    }

    function commitTwice(address token, uint256 first, uint256 second) external {
        commitments.commit(token, first);
        commitments.commit(token, second);
    }
}
