// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterClubPass} from "../src/FilterClubPass.sol";

/// @notice Test double for the launcher side of the pass handshake. `consumeCredit` is gated
///         to `msg.sender == launcher`, so unit tests route consumption through this contract
///         (wired via the one-shot `setLauncher`). Also exposes the `aborted(uint256)` view
///         that `reclaimCredit` reads (mirrors FilterLauncher's public mapping) so the reclaim
///         path is testable without standing up the full launcher.
contract MockCreditLauncher {
    FilterClubPass public pass;
    mapping(uint256 => bool) public aborted;

    function setPass(FilterClubPass pass_) external {
        pass = pass_;
    }

    function setAborted(uint256 seasonId, bool v) external {
        aborted[seasonId] = v;
    }

    function consume(address holder, uint256 seasonId) external returns (bool) {
        return pass.consumeCredit(holder, seasonId);
    }
}

/// @notice Payout recipient whose receive reverts — drives the `PayoutFailed` mint branch
///         (the runbook hazard the `payoutRecipient` NatSpec warns about).
contract RevertingRecipient {
    receive() external payable {
        revert("no ETH here");
    }
}

/// @title FilterClubPassTest
/// @notice Unit coverage of the Filter Club lifetime pass (spec §47.3.8 / Epic 2.6):
///         FCFS mint mechanics (exact payment, wallet cap, sellout, pause, payout push),
///         credit bookkeeping (2 per token, travels on transfer), the launcher-only
///         `consumeCredit` selection logic (armed preference, zero-credit skip, season
///         redemption cap, false-not-revert contract), and the owner wiring surface
///         (one-shot setLauncher, metadata freeze).
contract FilterClubPassTest is Test {
    uint256 internal constant MAX_SUPPLY = 250;
    uint256 internal constant MINT_PRICE = 0.05 ether;
    uint32 internal constant WALLET_CAP = 5;

    FilterClubPass pass;
    MockCreditLauncher mockLauncher;

    address owner = address(this);
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        pass = new FilterClubPass(owner, treasury, "ipfs://club/", MAX_SUPPLY, MINT_PRICE, WALLET_CAP);
        mockLauncher = new MockCreditLauncher();
        mockLauncher.setPass(pass);
        pass.setLauncher(address(mockLauncher));

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function _mint(address to, uint256 qty) internal {
        vm.prank(to);
        pass.mint{value: MINT_PRICE * qty}(qty);
    }

    // ============================================================ Mint — happy path

    function test_MintSingle() public {
        vm.expectEmit(true, true, false, true, address(pass));
        emit FilterClubPass.Minted(alice, 1, MINT_PRICE);
        _mint(alice, 1);

        assertEq(pass.ownerOf(1), alice);
        assertEq(pass.balanceOf(alice), 1);
        assertEq(pass.creditsOf(1), 2, "fresh pass carries CREDITS_PER_TOKEN");
        assertEq(pass.creditsRemaining(alice), 2);
        assertEq(pass.totalMinted(), 1);
        assertEq(pass.totalSupply(), 1);
        assertEq(pass.mintedBy(alice), 1);
    }

    function test_MintMultiQty() public {
        // One Minted event per token, ids sequential from 1, pricePaid is the per-token price.
        vm.expectEmit(true, true, false, true, address(pass));
        emit FilterClubPass.Minted(alice, 1, MINT_PRICE);
        vm.expectEmit(true, true, false, true, address(pass));
        emit FilterClubPass.Minted(alice, 2, MINT_PRICE);
        vm.expectEmit(true, true, false, true, address(pass));
        emit FilterClubPass.Minted(alice, 3, MINT_PRICE);
        _mint(alice, 3);

        assertEq(pass.totalMinted(), 3);
        for (uint256 t = 1; t <= 3; ++t) {
            assertEq(pass.ownerOf(t), alice);
            assertEq(pass.creditsOf(t), 2, "each token carries 2 credits");
        }
        assertEq(pass.creditsRemaining(alice), 6);

        // Second minter continues the id sequence.
        _mint(bob, 1);
        assertEq(pass.ownerOf(4), bob);
        assertEq(pass.totalMinted(), 4);
    }

    // ============================================================ Mint — payment

    function test_Mint_RevertsOnOverpayment() public {
        vm.prank(alice);
        vm.expectRevert(FilterClubPass.WrongPayment.selector);
        pass.mint{value: MINT_PRICE + 1}(1);
    }

    function test_Mint_RevertsOnUnderpayment() public {
        vm.prank(alice);
        vm.expectRevert(FilterClubPass.WrongPayment.selector);
        pass.mint{value: MINT_PRICE - 1}(1);

        // Multi-qty must pay price × qty exactly; a single unit's price is an underpayment.
        vm.prank(alice);
        vm.expectRevert(FilterClubPass.WrongPayment.selector);
        pass.mint{value: MINT_PRICE}(2);
    }

    function test_Mint_ExactPaymentSucceeds() public {
        vm.prank(alice);
        pass.mint{value: MINT_PRICE * 2}(2);
        assertEq(pass.totalMinted(), 2);
    }

    function test_Mint_RevertsOnZeroQty() public {
        vm.prank(alice);
        vm.expectRevert(FilterClubPass.InvalidQuantity.selector);
        pass.mint{value: 0}(0);
    }

    // ============================================================ Mint — wallet cap

    function test_WalletCap_BoundaryAtFive() public {
        _mint(alice, 3);
        _mint(alice, 2); // cumulative 5 == cap: OK
        assertEq(pass.mintedBy(alice), 5);

        vm.prank(alice);
        vm.expectRevert(FilterClubPass.WalletCapExceeded.selector);
        pass.mint{value: MINT_PRICE}(1);

        // Crossing the cap mid-batch also reverts (4 minted + 2 > 5).
        _mint(bob, 4);
        vm.prank(bob);
        vm.expectRevert(FilterClubPass.WalletCapExceeded.selector);
        pass.mint{value: MINT_PRICE * 2}(2);
    }

    function test_WalletCap_CountsMintsNotHoldings() public {
        _mint(alice, 5);
        // Transferring passes away does NOT free up mint quota — the cap counts mints.
        vm.startPrank(alice);
        pass.transferFrom(alice, bob, 1);
        pass.transferFrom(alice, bob, 2);
        vm.stopPrank();
        assertEq(pass.balanceOf(alice), 3);

        vm.prank(alice);
        vm.expectRevert(FilterClubPass.WalletCapExceeded.selector);
        pass.mint{value: MINT_PRICE}(1);
    }

    // ============================================================ Mint — sellout

    function test_Sellout_AtExactMaxSupply() public {
        // Small dedicated instance (maxSupply 6) keeps the sellout walk fast.
        FilterClubPass small = new FilterClubPass(owner, treasury, "ipfs://s/", 6, MINT_PRICE, WALLET_CAP);
        vm.prank(alice);
        small.mint{value: MINT_PRICE * 5}(5);
        // Exactly-at-cap batch is legal.
        vm.prank(bob);
        small.mint{value: MINT_PRICE}(1);
        assertEq(small.totalMinted(), 6);

        // Sold out: any further mint reverts, even qty 1.
        vm.prank(carol);
        vm.expectRevert(FilterClubPass.SoldOut.selector);
        small.mint{value: MINT_PRICE}(1);
    }

    function test_Sellout_BatchCrossingCapReverts() public {
        FilterClubPass small = new FilterClubPass(owner, treasury, "ipfs://s/", 6, MINT_PRICE, WALLET_CAP);
        vm.prank(alice);
        small.mint{value: MINT_PRICE * 5}(5);
        // 5 minted; a 2-token batch would cross maxSupply 6.
        vm.prank(bob);
        vm.expectRevert(FilterClubPass.SoldOut.selector);
        small.mint{value: MINT_PRICE * 2}(2);
        // The boundary single still fits.
        vm.prank(bob);
        small.mint{value: MINT_PRICE}(1);
        assertEq(small.totalMinted(), 6);
    }

    // ============================================================ Pause

    function test_Pause_BlocksMintOnly() public {
        _mint(alice, 1);
        pass.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        pass.mint{value: MINT_PRICE}(1);

        // consumeCredit stays live while paused (game path never depends on pause state).
        assertTrue(mockLauncher.consume(alice, 1), "consume works while paused");
        assertEq(pass.creditsOf(1), 1);

        // reclaimCredit stays live while paused too.
        mockLauncher.setAborted(1, true);
        pass.reclaimCredit(1, alice);
        assertEq(pass.creditsOf(1), 2, "reclaim restored the credit while paused");

        // Unpause restores mint.
        pass.setPaused(false);
        _mint(alice, 1);
        assertEq(pass.totalMinted(), 2);
    }

    // ============================================================ Payout push

    function test_Payout_PushesToRecipientPerMint() public {
        uint256 before = treasury.balance;
        _mint(alice, 3);
        assertEq(treasury.balance - before, MINT_PRICE * 3, "full msg.value pushed to payoutRecipient");
        assertEq(address(pass).balance, 0, "pass never custodies ETH");

        _mint(bob, 1);
        assertEq(treasury.balance - before, MINT_PRICE * 4);
        assertEq(address(pass).balance, 0);
    }

    function test_Payout_RevertingRecipientBricksMintWithNoStateChange() public {
        RevertingRecipient bad = new RevertingRecipient();
        FilterClubPass bricked =
            new FilterClubPass(owner, address(bad), "ipfs://b/", MAX_SUPPLY, MINT_PRICE, WALLET_CAP);

        vm.prank(alice);
        vm.expectRevert(FilterClubPass.PayoutFailed.selector);
        bricked.mint{value: MINT_PRICE}(1);

        // Whole tx rolled back: no token, no credits, no cap consumption, no stray ETH.
        assertEq(bricked.totalMinted(), 0);
        assertEq(bricked.creditsOf(1), 0);
        assertEq(bricked.mintedBy(alice), 0);
        assertEq(bricked.balanceOf(alice), 0);
        assertEq(address(bricked).balance, 0);

        // Runbook recovery: rotate payoutRecipient to a receiving address; mint revives.
        bricked.setPayoutRecipient(treasury);
        vm.prank(alice);
        bricked.mint{value: MINT_PRICE}(1);
        assertEq(bricked.totalMinted(), 1);
        assertEq(address(bricked).balance, 0);
    }

    // ============================================================ Credits travel on transfer

    function test_CreditsTravelWithToken() public {
        _mint(alice, 1);
        assertEq(pass.creditsRemaining(alice), 2);

        vm.prank(alice);
        pass.transferFrom(alice, bob, 1);

        // Credits are keyed to the tokenId, not the wallet.
        assertEq(pass.creditsOf(1), 2, "creditsOf unchanged by transfer");
        assertEq(pass.creditsRemaining(bob), 2, "new owner holds the credits");
        assertEq(pass.creditsRemaining(alice), 0, "old owner has none");

        // New owner can consume against the travelled token.
        assertTrue(mockLauncher.consume(bob, 1));
        assertEq(pass.creditsOf(1), 1);
    }

    // ============================================================ Metadata

    function test_TokenURI_UsesBaseURI() public {
        _mint(alice, 1);
        assertEq(pass.tokenURI(1), "ipfs://club/1");
    }

    function test_SetBaseURI_UpdatesUntilFrozen() public {
        _mint(alice, 1);
        vm.expectEmit(false, false, false, true, address(pass));
        emit FilterClubPass.BaseURISet("ipfs://v2/");
        pass.setBaseURI("ipfs://v2/");
        assertEq(pass.tokenURI(1), "ipfs://v2/1");

        vm.expectEmit(false, false, false, true, address(pass));
        emit FilterClubPass.MetadataFrozenSet();
        pass.freezeMetadata();
        assertTrue(pass.metadataFrozen());

        vm.expectRevert(FilterClubPass.MetadataFrozen.selector);
        pass.setBaseURI("ipfs://v3/");
        // Reads still work post-freeze.
        assertEq(pass.tokenURI(1), "ipfs://v2/1");
    }

    function test_SetBaseURI_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        pass.setBaseURI("ipfs://evil/");
    }

    // ============================================================ setLauncher wiring

    function test_SetLauncher_SecondCallReverts() public {
        // setUp already wired the mock launcher — the wire is one-shot.
        vm.expectRevert(FilterClubPass.AlreadySet.selector);
        pass.setLauncher(makeAddr("launcher2"));
    }

    function test_SetLauncher_ZeroAddressReverts() public {
        FilterClubPass fresh =
            new FilterClubPass(owner, treasury, "ipfs://f/", MAX_SUPPLY, MINT_PRICE, WALLET_CAP);
        vm.expectRevert(FilterClubPass.ZeroAddress.selector);
        fresh.setLauncher(address(0));
    }

    function test_SetLauncher_NonOwnerReverts() public {
        FilterClubPass fresh =
            new FilterClubPass(owner, treasury, "ipfs://f/", MAX_SUPPLY, MINT_PRICE, WALLET_CAP);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        fresh.setLauncher(alice);
    }

    // ============================================================ consumeCredit — auth

    function test_ConsumeCredit_EOARevertNotLauncher() public {
        _mint(alice, 1);
        vm.prank(alice);
        vm.expectRevert(FilterClubPass.NotLauncher.selector);
        pass.consumeCredit(alice, 1);
    }

    function test_ConsumeCredit_UnwiredPassFailsSafe() public {
        // Until setLauncher is called, consumeCredit reverts for EVERYONE (launcher == 0,
        // and msg.sender can never be address(0)).
        FilterClubPass fresh =
            new FilterClubPass(owner, treasury, "ipfs://f/", MAX_SUPPLY, MINT_PRICE, WALLET_CAP);
        vm.prank(alice);
        vm.expectRevert(FilterClubPass.NotLauncher.selector);
        fresh.consumeCredit(alice, 1);
    }

    // ============================================================ consumeCredit — selection

    function test_ConsumeCredit_AutoSelectSkipsDrainedToken() public {
        _mint(alice, 2); // tokens 1 and 2

        // Drain token 1 across two seasons (per-season defense-in-depth blocks a same-season
        // second consume for the same holder).
        vm.expectEmit(true, true, true, true, address(pass));
        emit FilterClubPass.CreditConsumed(1, alice, 1);
        assertTrue(mockLauncher.consume(alice, 1));
        assertTrue(mockLauncher.consume(alice, 2));
        assertEq(pass.creditsOf(1), 0, "token 1 drained");

        // Next consume must skip token 1 and pull token 2.
        vm.expectEmit(true, true, true, true, address(pass));
        emit FilterClubPass.CreditConsumed(2, alice, 3);
        assertTrue(mockLauncher.consume(alice, 3));
        assertEq(pass.creditsOf(2), 1);
        assertEq(pass.consumedTokenOf(3, alice), 2 + 1, "+1-offset record points at token 2");
    }

    function test_ConsumeCredit_SameSeasonSecondConsumeReturnsFalse() public {
        _mint(alice, 1);
        assertTrue(mockLauncher.consume(alice, 7));
        // Defense-in-depth: (season, holder) already recorded → false, nothing decremented.
        assertFalse(mockLauncher.consume(alice, 7));
        assertEq(pass.creditsOf(1), 1);
    }

    function test_ConsumeCredit_NoPassesReturnsFalse() public {
        assertFalse(mockLauncher.consume(alice, 1), "no passes -> false, not revert");
        assertEq(pass.redemptionsInSeason(1), 0);
    }

    function test_ConsumeCredit_AllCreditsDrainedReturnsFalse() public {
        _mint(alice, 1);
        assertTrue(mockLauncher.consume(alice, 1));
        assertTrue(mockLauncher.consume(alice, 2));
        assertEq(pass.creditsRemaining(alice), 0);
        assertFalse(mockLauncher.consume(alice, 3), "owned pass but zero credits -> false");
    }

    // ============================================================ armCredit

    function test_ArmCredit_PreferredTokenDrawnFirst() public {
        _mint(alice, 2); // tokens 1 and 2; auto-select would pick 1

        vm.expectEmit(true, true, false, true, address(pass));
        emit FilterClubPass.CreditArmed(alice, 2);
        vm.prank(alice);
        pass.armCredit(2);
        assertEq(pass.armedTokenOf(alice), 2 + 1);

        vm.expectEmit(true, true, true, true, address(pass));
        emit FilterClubPass.CreditConsumed(2, alice, 1);
        assertTrue(mockLauncher.consume(alice, 1));
        assertEq(pass.creditsOf(2), 1, "armed token consumed");
        assertEq(pass.creditsOf(1), 2, "lowest-index token untouched");
    }

    function test_ArmCredit_NotTokenOwnerReverts() public {
        _mint(alice, 1);
        vm.prank(bob);
        vm.expectRevert(FilterClubPass.NotTokenOwner.selector);
        pass.armCredit(1);
    }

    function test_ArmCredit_StaleAfterTransferFallsBackToScan() public {
        _mint(alice, 2);
        vm.prank(alice);
        pass.armCredit(2);
        // Armed token leaves the wallet — the preference goes stale, not sticky.
        vm.prank(alice);
        pass.transferFrom(alice, bob, 2);

        vm.expectEmit(true, true, true, true, address(pass));
        emit FilterClubPass.CreditConsumed(1, alice, 1);
        assertTrue(mockLauncher.consume(alice, 1));
        assertEq(pass.creditsOf(1), 1, "fallback scan selected token 1");
        assertEq(pass.creditsOf(2), 2, "transferred token untouched");
    }

    function test_ArmCredit_DrainedArmedTokenFallsBackToScan() public {
        _mint(alice, 2);
        vm.prank(alice);
        pass.armCredit(2);
        // Drain the armed token across two seasons.
        assertTrue(mockLauncher.consume(alice, 1));
        assertTrue(mockLauncher.consume(alice, 2));
        assertEq(pass.creditsOf(2), 0);

        // Third consume: armed token has no credits → scan picks token 1.
        vm.expectEmit(true, true, true, true, address(pass));
        emit FilterClubPass.CreditConsumed(1, alice, 3);
        assertTrue(mockLauncher.consume(alice, 3));
        assertEq(pass.creditsOf(1), 1);
    }

    // ============================================================ Season redemption cap

    function test_SeasonRedemptionCap_BindsAtN() public {
        vm.expectEmit(false, false, false, true, address(pass));
        emit FilterClubPass.SeasonRedemptionCapSet(2);
        pass.setSeasonRedemptionCap(2);

        _mint(alice, 1);
        _mint(bob, 1);
        _mint(carol, 1);

        uint256 sid = 42;
        assertTrue(mockLauncher.consume(alice, sid));
        assertTrue(mockLauncher.consume(bob, sid));
        assertEq(pass.redemptionsInSeason(sid), 2);

        // N+1th holder has credits but the season cap is hit → false, nothing burned.
        assertFalse(mockLauncher.consume(carol, sid));
        assertEq(pass.creditsRemaining(carol), 2, "no credit burned past the cap");
        assertEq(pass.redemptionsInSeason(sid), 2);

        // Cap is per-season: a different season still consumes.
        assertTrue(mockLauncher.consume(carol, sid + 1));
    }

    function test_SeasonRedemptionCap_ZeroDisablesConsumption() public {
        pass.setSeasonRedemptionCap(0);
        _mint(alice, 1);
        assertFalse(mockLauncher.consume(alice, 1), "cap 0 -> every consume returns false");
        assertEq(pass.creditsRemaining(alice), 2);
    }

    function test_SetSeasonRedemptionCap_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        pass.setSeasonRedemptionCap(1);
    }

    // ============================================================ Owner setters — bounds

    function test_SetWalletMintCap_ZeroReverts() public {
        vm.expectRevert(FilterClubPass.InvalidQuantity.selector);
        pass.setWalletMintCap(0);
        pass.setWalletMintCap(7);
        assertEq(pass.walletMintCap(), 7);
    }

    function test_SetPayoutRecipient_ZeroReverts() public {
        vm.expectRevert(FilterClubPass.ZeroAddress.selector);
        pass.setPayoutRecipient(address(0));
    }
}
