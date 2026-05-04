// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CreatorFeeDistributor} from "../src/CreatorFeeDistributor.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";

/// @notice Mock launcher that exposes both the `lockerOf`/`vaultOf` helpers (delegated to
///         MockLauncherView) AND an `Ownable.owner()` view so the distributor's multisig gate
///         resolves to a controllable address. The distributor reads `Ownable(launcher).owner()`
///         live (matches H-2's live-read pattern), so the mock has to mirror that surface.
contract MockOwnableLauncher is Ownable {
    MockLauncherView internal _view;

    constructor(address owner_) Ownable(owner_) {
        _view = new MockLauncherView();
    }

    function setLocker(uint256 seasonId, address token, address locker) external {
        _view.setLocker(seasonId, token, locker);
    }

    function setVault(uint256 seasonId, address vault) external {
        _view.setVault(seasonId, vault);
    }

    function lockerOf(uint256 seasonId, address token) external view returns (address) {
        return _view.lockerOf(seasonId, token);
    }

    function vaultOf(uint256 seasonId) external view returns (address) {
        return _view.vaultOf(seasonId);
    }
}

/// @notice Coverage for the perpetual creator-fee model (Epic 1.16 / spec §10.3 + §10.6).
///         Verifies:
///         - Auth: notifyFee gated by `launcher.lockerOf(seasonId, token)`.
///         - Auth: disableCreatorFee gated to `Ownable(launcher).owner()` (the multisig).
///         - Auth: claim gated to the registered creator.
///         - Perpetual accrual: 30 / 90 / 365 days post-launch all credit the creator (no cap).
///         - Disabled token: post-disable fees redirect to treasury; pre-disable accrual stays
///           claimable.
///         - Verify-transfer: notifyFee reverts if WETH didn't actually arrive.
contract CreatorFeeDistributorTest is Test {
    CreatorFeeDistributor distributor;
    CreatorRegistry registry;
    MockWETH weth;
    MockOwnableLauncher launcher;

    address multisig = makeAddr("multisig");
    address treasury = makeAddr("treasury");
    address tokenA = makeAddr("tokenA");
    address creatorA = makeAddr("creatorA");
    address locker = makeAddr("locker");
    address vault = makeAddr("vault");
    address attacker = makeAddr("attacker");

    uint256 constant SEASON = 1;

    function setUp() public {
        weth = new MockWETH();
        launcher = new MockOwnableLauncher(multisig);
        // The CreatorRegistry's `launcher` is the test contract here so we can register
        // (token → creator) directly without going through FilterLauncher.
        registry = new CreatorRegistry(address(this));
        distributor = new CreatorFeeDistributor(address(launcher), address(weth), treasury, registry);
        launcher.setLocker(SEASON, tokenA, locker);
        launcher.setVault(SEASON, vault);
    }

    function _registerToken(address token, address creator) internal {
        registry.register(token, creator);
        vm.prank(address(launcher));
        distributor.registerToken(token, SEASON);
    }

    function _notifyFee(address token, uint256 amount) internal {
        // Locker would have taken `amount` WETH directly into the distributor before
        // notifying. Simulate that here so the verify-transfer check passes.
        weth.mint(address(distributor), amount);
        vm.prank(locker);
        distributor.notifyFee(token, amount);
    }

    // ============================================================ Registration

    function test_RegisterToken_OnlyLauncher() public {
        vm.prank(attacker);
        vm.expectRevert(CreatorFeeDistributor.NotLauncher.selector);
        distributor.registerToken(tokenA, SEASON);
    }

    function test_RegisterToken_RejectsDouble() public {
        registry.register(tokenA, creatorA);
        vm.prank(address(launcher));
        distributor.registerToken(tokenA, SEASON);
        vm.prank(address(launcher));
        vm.expectRevert(CreatorFeeDistributor.AlreadyRegistered.selector);
        distributor.registerToken(tokenA, SEASON);
    }

    // ============================================================ notifyFee auth

    function test_NotifyFee_OnlyRegisteredLocker() public {
        _registerToken(tokenA, creatorA);
        weth.mint(address(distributor), 1 ether);
        vm.prank(attacker);
        vm.expectRevert(CreatorFeeDistributor.NotRegisteredLocker.selector);
        distributor.notifyFee(tokenA, 1 ether);
    }

    function test_NotifyFee_RejectsUnknownToken() public {
        weth.mint(address(distributor), 1 ether);
        vm.prank(locker);
        vm.expectRevert(CreatorFeeDistributor.UnknownToken.selector);
        distributor.notifyFee(tokenA, 1 ether);
    }

    function test_NotifyFee_RejectsUnverifiedTransfer() public {
        _registerToken(tokenA, creatorA);
        // Locker claims 1 WETH but didn't actually transfer it.
        vm.prank(locker);
        vm.expectRevert(CreatorFeeDistributor.UnverifiedTransfer.selector);
        distributor.notifyFee(tokenA, 1 ether);
    }

    // ============================================================ Perpetual accrual

    function test_NotifyFee_AccruesAtLaunch() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 1 ether);
        assertEq(distributor.pendingClaim(tokenA), 1 ether, "in-window: full credit");
    }

    /// @notice Spec §10.3: creators of winning tokens earn forever. 30 days post-launch the
    ///         pre-Epic 1.16 cap would have redirected this to treasury; it should now credit
    ///         the creator.
    function test_NotifyFee_AccruesAt30DaysPostLaunch() public {
        _registerToken(tokenA, creatorA);
        vm.warp(block.timestamp + 30 days);
        _notifyFee(tokenA, 1 ether);
        assertEq(distributor.pendingClaim(tokenA), 1 ether, "perpetual at 30d");
    }

    function test_NotifyFee_AccruesAt90DaysPostLaunch() public {
        _registerToken(tokenA, creatorA);
        vm.warp(block.timestamp + 90 days);
        _notifyFee(tokenA, 0.5 ether);
        assertEq(distributor.pendingClaim(tokenA), 0.5 ether, "perpetual at 90d");
    }

    function test_NotifyFee_AccruesAt365DaysPostLaunch() public {
        _registerToken(tokenA, creatorA);
        vm.warp(block.timestamp + 365 days);
        _notifyFee(tokenA, 2 ether);
        assertEq(distributor.pendingClaim(tokenA), 2 ether, "perpetual at 365d");
    }

    /// @notice Multiple cumulative accruals over an extended timeline mirror the perpetual
    ///         long-tail: every fee event credits the creator with no implicit cut-off.
    function test_NotifyFee_CumulativeAccrualOverYear() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 0.1 ether);
        vm.warp(block.timestamp + 7 days);
        _notifyFee(tokenA, 0.2 ether);
        vm.warp(block.timestamp + 60 days);
        _notifyFee(tokenA, 0.3 ether);
        vm.warp(block.timestamp + 200 days);
        _notifyFee(tokenA, 0.4 ether);
        assertEq(distributor.pendingClaim(tokenA), 1 ether, "cumulative perpetual accrual");
    }

    // ============================================================ Multisig disable

    function test_DisableCreatorFee_OnlyMultisig() public {
        _registerToken(tokenA, creatorA);
        vm.prank(attacker);
        vm.expectRevert(CreatorFeeDistributor.NotMultisig.selector);
        distributor.disableCreatorFee(tokenA);
    }

    function test_DisableCreatorFee_RejectsUnknownToken() public {
        vm.prank(multisig);
        vm.expectRevert(CreatorFeeDistributor.UnknownToken.selector);
        distributor.disableCreatorFee(tokenA);
    }

    function test_DisableCreatorFee_HappyPath() public {
        _registerToken(tokenA, creatorA);
        vm.expectEmit(true, false, false, false);
        emit CreatorFeeDistributor.CreatorFeeDisabled(tokenA);
        vm.prank(multisig);
        distributor.disableCreatorFee(tokenA);
        assertTrue(distributor.isDisabled(tokenA));
    }

    function test_DisableCreatorFee_Idempotent() public {
        _registerToken(tokenA, creatorA);
        vm.prank(multisig);
        distributor.disableCreatorFee(tokenA);
        // Second call is a no-op (no event emit, no state change beyond the first).
        vm.prank(multisig);
        distributor.disableCreatorFee(tokenA);
        assertTrue(distributor.isDisabled(tokenA));
    }

    /// @notice Audit-relevant: ownership transfer on the launcher rotates the disable
    ///         authority. Pre-rotation: old multisig succeeds, new one reverts. Post-rotation:
    ///         flipped. Mirrors the H-2 live-read property for the disable gate.
    function test_DisableCreatorFee_FollowsLauncherOwnership() public {
        _registerToken(tokenA, creatorA);
        address newMultisig = makeAddr("newMultisig");

        // Pre-rotation: new multisig has no authority.
        vm.prank(newMultisig);
        vm.expectRevert(CreatorFeeDistributor.NotMultisig.selector);
        distributor.disableCreatorFee(tokenA);

        // Rotate launcher ownership (Ownable, not Ownable2Step here, so single-step).
        vm.prank(multisig);
        launcher.transferOwnership(newMultisig);

        // Old multisig now reverts; new one succeeds.
        vm.prank(multisig);
        vm.expectRevert(CreatorFeeDistributor.NotMultisig.selector);
        distributor.disableCreatorFee(tokenA);
        vm.prank(newMultisig);
        distributor.disableCreatorFee(tokenA);
        assertTrue(distributor.isDisabled(tokenA));
    }

    function test_NotifyFee_RedirectsWhenDisabled() public {
        _registerToken(tokenA, creatorA);
        vm.prank(multisig);
        distributor.disableCreatorFee(tokenA);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        _notifyFee(tokenA, 1 ether);
        assertEq(distributor.pendingClaim(tokenA), 0, "no creator credit when disabled");
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 1 ether, "redirected to treasury");
    }

    /// @notice Disable sweeps PRE-disable accrual to treasury and redirects post-disable fees.
    ///         Pre-fix this test asserted that pre-disable accrual remained claimable — that was
    ///         the bugbot finding (Medium): a sanctioned recipient could still pull pre-disable
    ///         WETH via `claim()`, defeating the emergency. Now both halves go to treasury.
    function test_DisableCreatorFee_SweepsPendingAndRedirectsFuture() public {
        _registerToken(tokenA, creatorA);

        _notifyFee(tokenA, 0.4 ether);
        assertEq(distributor.pendingClaim(tokenA), 0.4 ether);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(multisig);
        distributor.disableCreatorFee(tokenA);
        assertEq(distributor.pendingClaim(tokenA), 0, "pre-disable accrual swept to treasury");
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 0.4 ether, "treasury captured pending");

        // Post-disable fees still flow to treasury, on top of the swept pending.
        _notifyFee(tokenA, 0.6 ether);
        assertEq(distributor.pendingClaim(tokenA), 0, "no creator credit when disabled");
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 1 ether, "treasury captured both halves");
    }

    /// @notice The sweep should fire only when there's something pending — disable on a
    ///         freshly-registered token emits only `CreatorFeeDisabled`, no `CreatorFeeRedirected`.
    function test_DisableCreatorFee_NoSweepEventWhenNothingPending() public {
        _registerToken(tokenA, creatorA);
        // Capture: only CreatorFeeDisabled should be emitted.
        vm.recordLogs();
        vm.prank(multisig);
        distributor.disableCreatorFee(tokenA);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Exactly one event from the distributor; transferring 0 WETH would emit a Transfer too,
        // so we assert by topic on the distributor's own events only.
        bytes32 disabledSig = keccak256("CreatorFeeDisabled(address)");
        bytes32 redirectedSig = keccak256("CreatorFeeRedirected(address,uint256)");
        uint256 disabledCount;
        uint256 redirectedCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(distributor)) continue;
            if (logs[i].topics[0] == disabledSig) disabledCount++;
            if (logs[i].topics[0] == redirectedSig) redirectedCount++;
        }
        assertEq(disabledCount, 1, "one disable event");
        assertEq(redirectedCount, 0, "no spurious redirect when pending == 0");
    }

    /// @notice Once disabled, `claim()` reverts — even for the registered creator, even when
    ///         pre-disable accrual existed. Closes the bugbot Medium-severity gap.
    function test_Claim_RevertsWhenDisabled() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 1 ether);
        vm.prank(multisig);
        distributor.disableCreatorFee(tokenA);

        vm.prank(creatorA);
        vm.expectRevert(CreatorFeeDistributor.Disabled.selector);
        distributor.claim(tokenA);
    }

    // ============================================================ Claim

    function test_Claim_OnlyCreator() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 1 ether);
        vm.prank(attacker);
        vm.expectRevert(CreatorFeeDistributor.NotCreator.selector);
        distributor.claim(tokenA);
    }

    function test_Claim_HappyPath() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 1 ether);
        vm.prank(creatorA);
        uint256 paid = distributor.claim(tokenA);
        assertEq(paid, 1 ether);
        assertEq(weth.balanceOf(creatorA), 1 ether);
        assertEq(distributor.pendingClaim(tokenA), 0);
    }

    function test_Claim_OnlyPaysOutDelta() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 0.4 ether);
        vm.prank(creatorA);
        distributor.claim(tokenA);
        assertEq(weth.balanceOf(creatorA), 0.4 ether);

        // Second swap accrues more fees.
        _notifyFee(tokenA, 0.6 ether);
        vm.prank(creatorA);
        distributor.claim(tokenA);
        // Creator total = 0.4 + 0.6 = 1.0 (only the new 0.6 paid this round).
        assertEq(weth.balanceOf(creatorA), 1 ether);
    }

    function test_Claim_NoOpWhenNothingPending() public {
        _registerToken(tokenA, creatorA);
        vm.prank(creatorA);
        uint256 paid = distributor.claim(tokenA);
        assertEq(paid, 0);
        assertEq(weth.balanceOf(creatorA), 0);
    }

    function test_Claim_RejectsUnknownToken() public {
        vm.prank(creatorA);
        vm.expectRevert(CreatorFeeDistributor.UnknownToken.selector);
        distributor.claim(tokenA);
    }

    /// @notice Claim works on the perpetual long-tail: a year after launch the creator can
    ///         still pull whatever has accrued. Pre-Epic 1.16 the accrual would have been zero
    ///         (cap caught it); post-Epic 1.16 the creator gets the full long-tail.
    function test_Claim_PerpetualLongTail() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 0.1 ether);
        vm.warp(block.timestamp + 365 days);
        _notifyFee(tokenA, 0.9 ether);
        vm.prank(creatorA);
        uint256 paid = distributor.claim(tokenA);
        assertEq(paid, 1 ether, "claim sweeps full long-tail");
    }

    /// @notice Epic 1.12 integration — when the admin redirects the recipient via the
    ///         registry, claim() pays the new recipient.
    function test_Claim_PaysRecipientWhenAdminHasRedirected() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 1 ether);

        address newRecipient = makeAddr("newRecipient");
        // creator (= default admin) redirects the recipient.
        vm.prank(creatorA);
        registry.setCreatorRecipient(tokenA, newRecipient);

        vm.prank(creatorA);
        uint256 paid = distributor.claim(tokenA);
        assertEq(paid, 1 ether);
        assertEq(weth.balanceOf(newRecipient), 1 ether);
        assertEq(weth.balanceOf(creatorA), 0);
    }

    // ============================================================ Disabled view

    function test_IsDisabled_DefaultsFalse() public {
        _registerToken(tokenA, creatorA);
        assertFalse(distributor.isDisabled(tokenA));
    }

    function test_IsDisabled_FalseForUnregisteredToken() public view {
        assertFalse(distributor.isDisabled(tokenA));
    }
}
