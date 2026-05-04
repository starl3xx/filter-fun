// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CreatorFeeDistributor} from "../src/CreatorFeeDistributor.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";

/// @notice Exhaustive coverage for the creator-fee accrual model. Covers:
///         - Auth: notifyFee gated by `launcher.lockerOf(seasonId, token)`.
///         - Auth: markFiltered gated by `launcher.vaultOf(seasonId)`.
///         - Auth: claim gated to the registered creator.
///         - Eligibility window: in-window credits, post-72h redirect to treasury.
///         - Filtered short-circuit: post-markFiltered, fees redirect to treasury.
///         - Verify-transfer: notifyFee reverts if WETH didn't actually arrive.
contract CreatorFeeDistributorTest is Test {
    CreatorFeeDistributor distributor;
    CreatorRegistry registry;
    MockWETH weth;
    MockLauncherView launcher;

    address treasury = makeAddr("treasury");
    address tokenA = makeAddr("tokenA");
    address creatorA = makeAddr("creatorA");
    address locker = makeAddr("locker");
    address vault = makeAddr("vault");
    address attacker = makeAddr("attacker");

    uint256 constant SEASON = 1;

    function setUp() public {
        weth = new MockWETH();
        launcher = new MockLauncherView();
        // Use the test contract as the registry's launcher so we can register
        // tokens directly — the production path goes through FilterLauncher.
        registry = new CreatorRegistry(address(this));
        distributor = new CreatorFeeDistributor(address(this), address(weth), treasury, registry);

        // Wire the locker/vault for this token+season into the mock launcher view so the
        // distributor's auth checks resolve correctly when called by `locker` or `vault`.
        launcher.setLocker(SEASON, tokenA, locker);
        launcher.setVault(SEASON, vault);

        // Production path uses launcher as both. We cheat the auth by switching out the
        // distributor's `launcher` immutable in setup via redeploy — but since `launcher`
        // is immutable on the distributor too, just overwrite the mock launcher's expected
        // values to match address(this).
        // Workaround: redeploy distributor with mockLauncher as its `launcher`.
        distributor = new CreatorFeeDistributor(address(launcher), address(weth), treasury, registry);
    }

    /// @dev Helper: register a token via the registry (test contract is the registry's
    ///      launcher), and via the distributor (called by mockLauncher because that's the
    ///      distributor's `launcher`).
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

    // ============================================================ Eligibility window

    function test_NotifyFee_AccruesWithinWindow() public {
        _registerToken(tokenA, creatorA);
        _notifyFee(tokenA, 1 ether);
        assertEq(distributor.pendingClaim(tokenA), 1 ether, "in-window: full credit");
        assertTrue(distributor.eligible(tokenA));
    }

    function test_NotifyFee_RedirectsAfter72h() public {
        _registerToken(tokenA, creatorA);
        // Fast-forward past the eligibility window.
        vm.warp(block.timestamp + 72 hours + 1);
        assertFalse(distributor.eligible(tokenA), "past 72h");

        uint256 treasuryBefore = weth.balanceOf(treasury);
        _notifyFee(tokenA, 1 ether);
        assertEq(distributor.pendingClaim(tokenA), 0, "no creator credit");
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 1 ether, "redirected to treasury");
    }

    function test_NotifyFee_RedirectsWhenFiltered() public {
        _registerToken(tokenA, creatorA);
        vm.prank(vault);
        distributor.markFiltered(tokenA);
        assertFalse(distributor.eligible(tokenA), "filtered = ineligible");

        uint256 treasuryBefore = weth.balanceOf(treasury);
        _notifyFee(tokenA, 1 ether);
        assertEq(distributor.pendingClaim(tokenA), 0, "no creator credit when filtered");
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 1 ether, "redirected to treasury");
    }

    /// @notice Hybrid: inside the 72h window, accrue some fees, then filter the token, then
    ///         a later swap fee post-filter. Pre-filter accrual stays claimable; post-filter
    ///         fees redirect.
    function test_NotifyFee_PreFilterClaimable_PostFilterRedirected() public {
        _registerToken(tokenA, creatorA);

        _notifyFee(tokenA, 0.4 ether);
        assertEq(distributor.pendingClaim(tokenA), 0.4 ether);

        vm.prank(vault);
        distributor.markFiltered(tokenA);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        _notifyFee(tokenA, 0.6 ether);
        // Pre-filter accrual remains claimable.
        assertEq(distributor.pendingClaim(tokenA), 0.4 ether);
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 0.6 ether);
    }

    // ============================================================ markFiltered auth

    function test_MarkFiltered_OnlyRegisteredVault() public {
        _registerToken(tokenA, creatorA);
        vm.prank(attacker);
        vm.expectRevert(CreatorFeeDistributor.NotRegisteredVault.selector);
        distributor.markFiltered(tokenA);
    }

    function test_MarkFiltered_Idempotent() public {
        _registerToken(tokenA, creatorA);
        vm.prank(vault);
        distributor.markFiltered(tokenA);
        // Second call no-ops (no event emit, no state change).
        vm.prank(vault);
        distributor.markFiltered(tokenA);
        CreatorFeeDistributor.TokenInfo memory info = distributor.infoOf(tokenA);
        assertTrue(info.filtered);
    }

    function test_MarkFiltered_RejectsUnknownToken() public {
        vm.prank(vault);
        vm.expectRevert(CreatorFeeDistributor.UnknownToken.selector);
        distributor.markFiltered(tokenA);
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

    /// @notice Epic 1.12 integration — when the admin redirects the recipient via the
    ///         registry, claim() pays the new recipient. The creator still triggers the
    ///         claim (auth unchanged), but WETH lands at the configured recipient.
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
        assertEq(weth.balanceOf(newRecipient), 1 ether, "fee lands at redirected address");
        assertEq(weth.balanceOf(creatorA), 0, "creator no longer receives the fee");
    }

    // ============================================================ Eligibility view

    function test_Eligible_FalseBeforeRegister() public view {
        assertFalse(distributor.eligible(tokenA));
    }

    function test_Eligible_TrueRightAfterLaunch() public {
        _registerToken(tokenA, creatorA);
        assertTrue(distributor.eligible(tokenA));
    }

    function test_Eligible_RightAtBoundary() public {
        _registerToken(tokenA, creatorA);
        // Window is `<=`: at exactly +72h, still eligible.
        vm.warp(block.timestamp + 72 hours);
        assertTrue(distributor.eligible(tokenA), "eligible at exact boundary");
        // One second past, not eligible.
        vm.warp(block.timestamp + 1);
        assertFalse(distributor.eligible(tokenA), "ineligible 1s after");
    }

    // ============================================================ Operator: disableCreatorFee
    //
    // Epic 1.21 / spec §47.4.2 — emergency disable surface for sanctioned / compromised
    // creator addresses. Reuses the launcher's `owner()` as the operator key (the
    // multisig in production); a free-text `reason` is required to keep the audit trail
    // meaningful and is logged via `OperatorActionEmitted` for the indexer's
    // OperatorActionLog table.

    address constant OPERATOR = address(0xDEAD0011BEEF);

    function test_DisableCreatorFee_RejectsNonOperator() public {
        _registerToken(tokenA, creatorA);
        launcher.setOwner(OPERATOR);
        vm.prank(attacker);
        vm.expectRevert(CreatorFeeDistributor.NotMultisig.selector);
        distributor.disableCreatorFee(tokenA, "compromised");
    }

    function test_DisableCreatorFee_RejectsEmptyReason() public {
        _registerToken(tokenA, creatorA);
        launcher.setOwner(OPERATOR);
        vm.prank(OPERATOR);
        vm.expectRevert(CreatorFeeDistributor.EmptyReason.selector);
        distributor.disableCreatorFee(tokenA, "");
    }

    function test_DisableCreatorFee_RejectsUnknownToken() public {
        launcher.setOwner(OPERATOR);
        vm.prank(OPERATOR);
        vm.expectRevert(CreatorFeeDistributor.UnknownToken.selector);
        distributor.disableCreatorFee(tokenA, "compromised");
    }

    function test_DisableCreatorFee_FlipsFilteredAndEmitsAudit() public {
        _registerToken(tokenA, creatorA);
        launcher.setOwner(OPERATOR);

        vm.expectEmit(true, false, false, true);
        emit CreatorFeeDistributor.CreatorFeeDisabled(tokenA);
        vm.expectEmit(true, false, false, true);
        emit CreatorFeeDistributor.OperatorActionEmitted(
            OPERATOR,
            "disableCreatorFee",
            abi.encode(tokenA, "compromised")
        );
        vm.prank(OPERATOR);
        distributor.disableCreatorFee(tokenA, "compromised");

        // Subsequent fee notifications now redirect to treasury (eligibility flipped to
        // false because info.filtered = true).
        weth.mint(address(distributor), 1 ether);
        vm.prank(locker);
        distributor.notifyFee(tokenA, 1 ether);
        assertEq(weth.balanceOf(treasury), 1 ether, "post-disable fee redirected to treasury");
    }

    function test_DisableCreatorFee_IdempotentReEmitsAudit() public {
        _registerToken(tokenA, creatorA);
        launcher.setOwner(OPERATOR);
        vm.prank(OPERATOR);
        distributor.disableCreatorFee(tokenA, "compromised");

        // Second call: state is already filtered=true, but the audit event MUST still
        // fire so every operator call lands a row in the indexer's OperatorActionLog.
        // The CreatorFeeDisabled event does NOT re-fire (idempotent state guard).
        vm.expectEmit(true, false, false, true);
        emit CreatorFeeDistributor.OperatorActionEmitted(
            OPERATOR,
            "disableCreatorFee",
            abi.encode(tokenA, "follow-up audit")
        );
        vm.prank(OPERATOR);
        distributor.disableCreatorFee(tokenA, "follow-up audit");
    }
}
