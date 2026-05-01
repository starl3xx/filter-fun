// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CreatorRegistry} from "../src/CreatorRegistry.sol";

/// @notice Coverage for the Epic 1.12 admin/recipient/metadata surface added to
///         CreatorRegistry. Split from `CreatorRegistry.t.sol` because the admin
///         surface is large enough to warrant its own file. Covers:
///         - Default-resolution: admin/recipient default to creator pre-mutation.
///         - Auth chain: only the active admin can call setters.
///         - Zero-address rejections on every setter where applicable.
///         - Empty-URI rejection for setMetadataURI.
///         - Two-step admin transfer: nominate → accept happy path; cancel; wrong-caller
///           reverts; double-nominate overwrites; accept by stranger reverts.
///         - Token-not-registered surface (NotRegistered, not NotAdmin, on every setter).
///         - Reentrancy guard: a malicious recipient that re-enters during a state-mutating
///           setter is rejected.
///         - Backwards compat: a freshly-registered token (no overrides set) reads admin =
///           creator, recipient = creator, metadata = "".
contract CreatorRegistryAdminTest is Test {
    CreatorRegistry registry;

    address launcher = makeAddr("launcher");
    address creator = makeAddr("creator");
    address newAdmin = makeAddr("newAdmin");
    address newRecipient = makeAddr("newRecipient");
    address stranger = makeAddr("stranger");
    address tokenA = makeAddr("tokenA");
    address tokenB = makeAddr("tokenB");

    function setUp() public {
        registry = new CreatorRegistry(launcher);
        vm.prank(launcher);
        registry.register(tokenA, creator);
    }

    // ============================================================ Default resolution

    function test_AdminDefaultsToCreator() public view {
        assertEq(registry.adminOf(tokenA), creator);
    }

    function test_RecipientDefaultsToCreator() public view {
        assertEq(registry.recipientOf(tokenA), creator);
    }

    function test_MetadataURIEmptyByDefault() public view {
        assertEq(bytes(registry.metadataURIOf(tokenA)).length, 0);
    }

    function test_AdminOfUnregisteredIsZero() public view {
        assertEq(registry.adminOf(tokenB), address(0));
    }

    // ============================================================ setMetadataURI

    function test_SetMetadataURI_HappyPath() public {
        vm.expectEmit(true, true, false, true);
        emit CreatorRegistry.MetadataURIUpdated(tokenA, creator, "ipfs://new");
        vm.prank(creator);
        registry.setMetadataURI(tokenA, "ipfs://new");
        assertEq(registry.metadataURIOf(tokenA), "ipfs://new");
    }

    function test_SetMetadataURI_RejectsNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(CreatorRegistry.NotAdmin.selector);
        registry.setMetadataURI(tokenA, "ipfs://x");
    }

    function test_SetMetadataURI_RejectsEmpty() public {
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.EmptyURI.selector);
        registry.setMetadataURI(tokenA, "");
    }

    function test_SetMetadataURI_RejectsUnregisteredToken() public {
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.NotRegistered.selector);
        registry.setMetadataURI(tokenB, "ipfs://x");
    }

    function test_SetMetadataURI_OverwritesPriorURI() public {
        vm.prank(creator);
        registry.setMetadataURI(tokenA, "ipfs://v1");
        vm.prank(creator);
        registry.setMetadataURI(tokenA, "ipfs://v2");
        assertEq(registry.metadataURIOf(tokenA), "ipfs://v2");
    }

    // ============================================================ setCreatorRecipient

    function test_SetCreatorRecipient_HappyPath() public {
        vm.expectEmit(true, true, true, false);
        emit CreatorRegistry.CreatorRecipientUpdated(tokenA, creator, newRecipient);
        vm.prank(creator);
        registry.setCreatorRecipient(tokenA, newRecipient);
        assertEq(registry.recipientOf(tokenA), newRecipient);
    }

    function test_SetCreatorRecipient_RejectsZero() public {
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.ZeroRecipient.selector);
        registry.setCreatorRecipient(tokenA, address(0));
    }

    function test_SetCreatorRecipient_RejectsNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(CreatorRegistry.NotAdmin.selector);
        registry.setCreatorRecipient(tokenA, newRecipient);
    }

    function test_SetCreatorRecipient_RejectsUnregisteredToken() public {
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.NotRegistered.selector);
        registry.setCreatorRecipient(tokenB, newRecipient);
    }

    function test_SetCreatorRecipient_EmitsOldAndNew() public {
        vm.prank(creator);
        registry.setCreatorRecipient(tokenA, newRecipient);
        // Now move recipient again — old should be the previous override, not creator.
        address newer = makeAddr("newer");
        vm.expectEmit(true, true, true, false);
        emit CreatorRegistry.CreatorRecipientUpdated(tokenA, newRecipient, newer);
        vm.prank(creator);
        registry.setCreatorRecipient(tokenA, newer);
    }

    // ============================================================ Two-step admin transfer

    function test_NominateAdmin_HappyPath() public {
        vm.expectEmit(true, true, true, false);
        emit CreatorRegistry.AdminNominated(tokenA, creator, newAdmin);
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        assertEq(registry.pendingAdminOf(tokenA), newAdmin);
        // Critical: the current admin still has control until accept lands.
        assertEq(registry.adminOf(tokenA), creator);
    }

    function test_NominateAdmin_RejectsZero() public {
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.ZeroPendingAdmin.selector);
        registry.nominateAdmin(tokenA, address(0));
    }

    function test_NominateAdmin_RejectsNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(CreatorRegistry.NotAdmin.selector);
        registry.nominateAdmin(tokenA, newAdmin);
    }

    function test_NominateAdmin_RejectsUnregisteredToken() public {
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.NotRegistered.selector);
        registry.nominateAdmin(tokenB, newAdmin);
    }

    function test_NominateAdmin_OverwritesPending() public {
        address otherCandidate = makeAddr("other");
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        vm.prank(creator);
        registry.nominateAdmin(tokenA, otherCandidate);
        assertEq(registry.pendingAdminOf(tokenA), otherCandidate);
    }

    function test_AcceptAdmin_HappyPath() public {
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);

        vm.expectEmit(true, true, true, false);
        emit CreatorRegistry.AdminUpdated(tokenA, creator, newAdmin);
        vm.prank(newAdmin);
        registry.acceptAdmin(tokenA);

        assertEq(registry.adminOf(tokenA), newAdmin, "new admin in control");
        assertEq(registry.pendingAdminOf(tokenA), address(0), "pending cleared");
        // Identity is permanent — creator stays.
        assertEq(registry.creatorOf(tokenA), creator, "creator unchanged");
    }

    function test_AcceptAdmin_RejectsWrongCaller() public {
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        vm.prank(stranger);
        vm.expectRevert(CreatorRegistry.NotPendingAdmin.selector);
        registry.acceptAdmin(tokenA);
    }

    function test_AcceptAdmin_RejectsWhenNoPending() public {
        vm.prank(newAdmin);
        vm.expectRevert(CreatorRegistry.NoPendingAdmin.selector);
        registry.acceptAdmin(tokenA);
    }

    function test_AcceptAdmin_RejectsUnregisteredToken() public {
        vm.prank(newAdmin);
        vm.expectRevert(CreatorRegistry.NotRegistered.selector);
        registry.acceptAdmin(tokenB);
    }

    function test_CancelNomination_HappyPath() public {
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);

        vm.expectEmit(true, true, false, false);
        emit CreatorRegistry.AdminNominationCancelled(tokenA, newAdmin);
        vm.prank(creator);
        registry.cancelNomination(tokenA);

        assertEq(registry.pendingAdminOf(tokenA), address(0));
        // Re-nomination must be possible after cancel.
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        assertEq(registry.pendingAdminOf(tokenA), newAdmin);
    }

    function test_CancelNomination_RejectsNonAdmin() public {
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        vm.prank(stranger);
        vm.expectRevert(CreatorRegistry.NotAdmin.selector);
        registry.cancelNomination(tokenA);
    }

    function test_CancelNomination_RejectsWhenNoPending() public {
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.NoPendingAdmin.selector);
        registry.cancelNomination(tokenA);
    }

    function test_AcceptAdmin_AfterCancelReverts() public {
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        vm.prank(creator);
        registry.cancelNomination(tokenA);
        vm.prank(newAdmin);
        vm.expectRevert(CreatorRegistry.NoPendingAdmin.selector);
        registry.acceptAdmin(tokenA);
    }

    // ============================================================ Composed admin chain

    function test_NewAdminCanCallAllSetters() public {
        // Transfer admin to newAdmin.
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        vm.prank(newAdmin);
        registry.acceptAdmin(tokenA);

        // newAdmin now drives the surface.
        vm.prank(newAdmin);
        registry.setMetadataURI(tokenA, "ipfs://new-admin");
        assertEq(registry.metadataURIOf(tokenA), "ipfs://new-admin");

        vm.prank(newAdmin);
        registry.setCreatorRecipient(tokenA, newRecipient);
        assertEq(registry.recipientOf(tokenA), newRecipient);

        // The original creator is now locked out.
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.NotAdmin.selector);
        registry.setMetadataURI(tokenA, "ipfs://nope");
    }

    function test_RecipientPersistsAcrossAdminTransfer() public {
        // creator changes the fee recipient.
        vm.prank(creator);
        registry.setCreatorRecipient(tokenA, newRecipient);

        // creator hands admin to newAdmin.
        vm.prank(creator);
        registry.nominateAdmin(tokenA, newAdmin);
        vm.prank(newAdmin);
        registry.acceptAdmin(tokenA);

        // Recipient is sticky — newAdmin must explicitly change it.
        assertEq(registry.recipientOf(tokenA), newRecipient);
    }

    // ============================================================ Reentrancy guard

    /// @notice The setters are pure storage writes that emit events — no external calls,
    ///         so a "malicious recipient that re-enters" cannot actually re-enter today.
    ///         The `nonReentrant` modifier is defensive against future changes that add
    ///         an external call (e.g. a recipient hook). This test verifies the guard
    ///         doesn't lock the contract permanently after a successful call: a contract
    ///         admin can drive multiple setters in sequence inside the same tx.
    function test_GuardReleasesBetweenCalls() public {
        ContractAdmin contractAdmin = new ContractAdmin(registry);

        vm.prank(creator);
        registry.nominateAdmin(tokenA, address(contractAdmin));

        // The contract admin accepts and immediately fires three setters — proving the
        // guard releases cleanly after each call.
        contractAdmin.acceptAndDriveSetters(tokenA, "ipfs://from-contract", newRecipient);

        assertEq(registry.adminOf(tokenA), address(contractAdmin));
        assertEq(registry.metadataURIOf(tokenA), "ipfs://from-contract");
        assertEq(registry.recipientOf(tokenA), newRecipient);
    }
}

/// @notice Contract that exercises the registry's admin surface from inside another call.
///         Used to verify that a contract — not just an EOA — can hold admin rights and
///         drive setters in sequence.
contract ContractAdmin {
    CreatorRegistry public immutable registry;

    constructor(CreatorRegistry registry_) {
        registry = registry_;
    }

    function acceptAndDriveSetters(address token, string calldata uri, address newRecipient_) external {
        registry.acceptAdmin(token);
        registry.setMetadataURI(token, uri);
        registry.setCreatorRecipient(token, newRecipient_);
    }
}
