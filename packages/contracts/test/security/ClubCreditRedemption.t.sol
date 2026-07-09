// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {FilterClubPass} from "../../src/FilterClubPass.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";
import {LauncherStakeAdmin} from "../../src/LauncherStakeAdmin.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../../src/interfaces/IFilterLauncher.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault} from "../../src/TournamentVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title ClubCreditRedemptionTest
/// @notice Spec §47.3.8 / Epic 2.6 — the launcher-side credit redemption contract, pinned
///         against the real launcher + escrow (mirrors EightStepValidation's harness):
///
///           - `msg.value == 0` is the unambiguous credit-intent signal: the pass is consulted
///             exactly then, and ONLY then. A nonzero underpayment NEVER consults the pass, so
///             a credit can never be silently burned by a fat-fingered partial payment.
///           - A successful credit reservation records a first-class zero-amount escrow row.
///           - The per-season redemption cap (genesis 4) folds into `InsufficientEscrow`;
///             paid reservations from the same wallet remain unaffected.
///           - Credit launches are full citizens of the activation state machine: they count
///             toward the threshold, deploy on-entry post-activation, respect the per-wallet
///             cap, and carry a zero refundable stake through both stake and fee modes.
contract ClubCreditRedemptionTest is Test {
    FilterLauncher launcher;
    FilterClubPass clubPass;
    LaunchEscrow escrow;
    MockFilterFactory factory;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polManager = address(0xF000);

    address creator = makeAddr("creator");

    receive() external payable {}

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        clubPass = new FilterClubPass(owner, treasury, "ipfs://club/", 250, 0.05 ether, 5);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth), clubPass
        );
        clubPass.setLauncher(address(launcher));
        factory = new MockFilterFactory(address(launcher), address(weth));
        // One-shot wire. Tournament wire required since `startSeason` zero-checks the
        // registry (audit: bugbot M PR #88); dummies suffice — this suite never
        // dereferences polManager/tournament.
        launcher.wire(
            IFilterFactory(address(factory)),
            IPOLManager(polManager),
            TournamentRegistry(address(0xDEAD)),
            TournamentVault(payable(address(0xBEEF)))
        );
        escrow = launcher.launchEscrow();
        vm.deal(creator, 100 ether);
    }

    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether;
        uint256 m = 12;
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    function _openSeason() internal returns (uint256 sid) {
        vm.prank(oracle);
        sid = launcher.startSeason();
    }

    /// @dev Mint one pass (2 credits) to `who`, funding the wallet first.
    function _mintPass(address who) internal returns (uint256 tokenId) {
        if (who.balance < 1 ether) vm.deal(who, 10 ether);
        vm.prank(who);
        clubPass.mint{value: 0.05 ether}(1);
        tokenId = clubPass.totalMinted();
    }

    /// @dev Fresh funded wallet keyed by index (per-wallet reservation cap workaround).
    function _wallet(uint256 idx) internal returns (address w) {
        w = address(uint160(0xC0DE00) + uint160(idx));
        if (w.balance < 1 ether) vm.deal(w, 10 ether);
    }

    /// @dev Auto-derived 4-char ticker "W<idx><idx><idx>" unique per index (0..9).
    function _ticker(uint256 idx) internal pure returns (string memory) {
        bytes1 c = bytes1(uint8(65 + idx)); // A, B, C, ...
        return string(abi.encodePacked("WK", c, c));
    }

    // ============================================================ Credit path — happy

    function test_CreditReserve_ZeroValueRecordsZeroAmountEscrowRow() public {
        uint256 sid = _openSeason();
        uint256 tokenId = _mintPass(creator);

        vm.expectEmit(true, true, true, true, address(clubPass));
        emit FilterClubPass.CreditConsumed(tokenId, creator, sid);
        vm.prank(creator);
        launcher.reserve{value: 0}("CRED", "ipfs://cred");

        // Escrow row exists (reservedAt sentinel) with amount == 0 — first-class record.
        LaunchEscrow.Reservation memory r = escrow.escrowOf(sid, creator);
        assertEq(r.amount, 0, "zero-value escrow row");
        assertEq(r.reservedAt, uint64(block.timestamp), "reservedAt sentinel set");
        assertEq(r.slotIndex, 0);
        assertEq(escrow.reservedAtOf(sid, creator), uint64(block.timestamp));
        assertEq(address(escrow).balance, 0, "no ETH escrowed for a credit slot");

        // Launcher-side bookkeeping identical to a paid reservation.
        assertEq(launcher.seasonTickers(sid, keccak256("CRED")), creator, "ticker registered");
        assertEq(launcher.pendingCount(sid), 1);

        // Pass-side: exactly one credit consumed, +1-offset record written.
        assertEq(clubPass.creditsOf(tokenId), 1, "credit decremented exactly once");
        assertEq(clubPass.consumedTokenOf(sid, creator), tokenId + 1);
        assertEq(clubPass.redemptionsInSeason(sid), 1);
    }

    // ============================================================ Credit path — failure surface

    function test_ZeroValueWithoutCredit_RevertsInsufficientEscrow() public {
        uint256 sid = _openSeason();
        // creator holds no pass at all.
        vm.prank(creator);
        vm.expectRevert(FilterLauncher.InsufficientEscrow.selector);
        launcher.reserve{value: 0}("NOCRED", "ipfs://n");

        assertEq(clubPass.redemptionsInSeason(sid), 0, "nothing consumed");
        assertEq(launcher.seasonTickers(sid, keccak256("NOCRED")), address(0), "no ticker registered");
        assertEq(escrow.reservationCountOf(sid), 0);
    }

    /// @notice THE critical never-silently-burn case: a nonzero underpayment must revert
    ///         `InsufficientEscrow` WITHOUT consulting the pass — the held credit survives.
    function test_NonzeroUnderpayment_NeverBurnsCredit() public {
        uint256 sid = _openSeason();
        uint256 tokenId = _mintPass(creator);
        uint256 cost = _slotCost(0);

        vm.prank(creator);
        vm.expectRevert(FilterLauncher.InsufficientEscrow.selector);
        launcher.reserve{value: cost - 1}("UNDR", "ipfs://u");

        // 1 wei is just as much a non-signal as cost-1.
        vm.prank(creator);
        vm.expectRevert(FilterLauncher.InsufficientEscrow.selector);
        launcher.reserve{value: 1}("UNDR", "ipfs://u");

        assertEq(clubPass.creditsOf(tokenId), 2, "credit NOT burned by underpayment");
        assertEq(clubPass.consumedTokenOf(sid, creator), 0, "no consumption record");
        assertEq(clubPass.redemptionsInSeason(sid), 0);
    }

    // ============================================================ Paid path never consults pass

    function test_ExactPaymentWithCreditsHeld_CreditUntouched() public {
        uint256 sid = _openSeason();
        uint256 tokenId = _mintPass(creator);
        uint256 cost = _slotCost(0);

        vm.prank(creator);
        launcher.reserve{value: cost}("PAID", "ipfs://p");

        LaunchEscrow.Reservation memory r = escrow.escrowOf(sid, creator);
        assertEq(r.amount, cost, "paid escrow row carries the cost");
        assertEq(clubPass.creditsOf(tokenId), 2, "paid path never consults the pass");
        assertEq(clubPass.consumedTokenOf(sid, creator), 0);
        assertEq(clubPass.redemptionsInSeason(sid), 0);
    }

    function test_OverpaymentRefund_WorksWithCreditsHeld() public {
        uint256 sid = _openSeason();
        uint256 tokenId = _mintPass(creator);
        uint256 cost = _slotCost(0);
        uint256 balBefore = creator.balance;

        vm.prank(creator);
        launcher.reserve{value: cost + 0.3 ether}("OVER", "ipfs://o");

        // Excess refunded in the same tx; only the cost left the wallet.
        assertEq(balBefore - creator.balance, cost, "excess refunded");
        assertEq(escrow.escrowOf(sid, creator).amount, cost, "escrow holds exactly the cost");
        assertEq(clubPass.creditsOf(tokenId), 2, "credit untouched on the overpaid path");
        assertEq(clubPass.consumedTokenOf(sid, creator), 0);
    }

    // ============================================================ Season redemption cap

    function test_SeasonRedemptionCap_FifthCreditBlockedButPaidWorks() public {
        uint256 sid = _openSeason();

        // 4 distinct wallets each mint a pass and credit-reserve (genesis cap = 4). The 4th
        // credit reservation is also the activation threshold — season goes live.
        for (uint256 i = 0; i < 4; ++i) {
            address w = _wallet(i);
            _mintPass(w);
            vm.prank(w);
            launcher.reserve{value: 0}(_ticker(i), "ipfs://m");
        }
        assertEq(clubPass.redemptionsInSeason(sid), 4, "cap reached");
        assertTrue(launcher.activated(sid));

        // 5th wallet holds credits, but the season cap folds into InsufficientEscrow.
        address fifth = _wallet(4);
        uint256 fifthToken = _mintPass(fifth);
        vm.prank(fifth);
        vm.expectRevert(FilterLauncher.InsufficientEscrow.selector);
        launcher.reserve{value: 0}(_ticker(4), "ipfs://m");
        assertEq(clubPass.creditsOf(fifthToken), 2, "capped credit attempt burns nothing");

        // The same wallet can still reserve the slot the old-fashioned way.
        vm.prank(fifth);
        launcher.reserve{value: _slotCost(4)}(_ticker(4), "ipfs://m");
        assertEq(launcher.launchCount(sid), 5, "paid reservation deployed on-entry");
        assertEq(clubPass.creditsOf(fifthToken), 2, "paid path left the credits alone");
    }

    // ============================================================ Activation state machine

    function test_CreditReservationAsFourth_ActivatesAndDeploysAllFour() public {
        uint256 sid = _openSeason();

        // Slots 0..2 paid.
        for (uint256 i = 0; i < 3; ++i) {
            address w = _wallet(i);
            vm.prank(w);
            launcher.reserve{value: _slotCost(uint64(i))}(_ticker(i), "ipfs://m");
        }
        assertEq(launcher.launchCount(sid), 0, "nothing deployed pre-threshold");

        // 4th reservation is a CREDIT launch — crosses the threshold, deploys the cohort.
        address clubber = _wallet(3);
        uint256 tokenId = _mintPass(clubber);
        vm.prank(clubber);
        launcher.reserve{value: 0}(_ticker(3), "ipfs://m");

        assertTrue(launcher.activated(sid), "credit reservation crossed the threshold");
        assertEq(launcher.launchCount(sid), 4, "all four deployed atomically");
        assertEq(launcher.tokensInSeason(sid).length, 4);
        assertEq(launcher.pendingCount(sid), 0, "queue drained");
        assertEq(address(escrow).balance, 0, "escrow fully released to deploy");
        assertEq(clubPass.creditsOf(tokenId), 1);

        // Zero-stake bookkeeping for the credit slot; full stake for a paid slot.
        address creditToken = launcher.tokensInSeason(sid)[3];
        IFilterLauncher.LaunchInfo memory creditInfo = launcher.launchInfoOf(sid, creditToken);
        assertEq(creditInfo.costPaid, 0, "credit slot cost recorded as 0");
        assertEq(creditInfo.stakeAmount, 0, "credit slot stakes nothing");
        address paidToken = launcher.tokensInSeason(sid)[0];
        assertEq(launcher.launchInfoOf(sid, paidToken).stakeAmount, uint128(_slotCost(0)));
    }

    function test_PostActivationCreditLaunch_DeploysOnEntry() public {
        uint256 sid = _openSeason();
        for (uint256 i = 0; i < 4; ++i) {
            address w = _wallet(i);
            vm.prank(w);
            launcher.reserve{value: _slotCost(uint64(i))}(_ticker(i), "ipfs://m");
        }
        assertTrue(launcher.activated(sid));
        assertEq(launcher.launchCount(sid), 4);

        // Credit reservation post-activation deploys in the same tx, no queuing.
        address clubber = _wallet(4);
        uint256 tokenId = _mintPass(clubber);
        vm.prank(clubber);
        launcher.reserve{value: 0}(_ticker(4), "ipfs://m");

        assertEq(launcher.launchCount(sid), 5, "deploy-on-entry");
        assertEq(launcher.pendingCount(sid), 0);
        assertEq(clubPass.creditsOf(tokenId), 1, "exactly one credit consumed");
        assertEq(clubPass.consumedTokenOf(sid, clubber), tokenId + 1);
        // The on-entry deploy's stake record is zero for the credit slot.
        address creditToken = launcher.tokensInSeason(sid)[4];
        assertEq(launcher.launchInfoOf(sid, creditToken).stakeAmount, 0);
    }

    function test_PerWalletCap_BindsCreditLaunches() public {
        uint256 sid = _openSeason();
        uint256 tokenId = _mintPass(creator); // 2 credits — but only 1 reservation allowed

        vm.prank(creator);
        launcher.reserve{value: 0}("FIRST", "ipfs://1");
        assertEq(clubPass.creditsOf(tokenId), 1);

        // Second credit attempt from the same wallet: per-wallet cap fires BEFORE the
        // payment step, so the remaining credit is not consumed.
        vm.prank(creator);
        vm.expectRevert(FilterLauncher.AlreadyReserved.selector);
        launcher.reserve{value: 0}("SECOND", "ipfs://2");
        assertEq(clubPass.creditsOf(tokenId), 1, "remaining credit untouched");
        assertEq(clubPass.redemptionsInSeason(sid), 1);

        // A paid second reservation is equally blocked — the cap is per-wallet, not per-mode.
        vm.prank(creator);
        vm.expectRevert(FilterLauncher.AlreadyReserved.selector);
        launcher.reserve{value: _slotCost(1)}("SECOND", "ipfs://2");
    }

    // ============================================================ Stake mode — zero-stake resolution

    /// @dev Shared scaffold: activate a season whose slot 3 is a credit launch, advance to
    ///      Filter so `applySoftFilter` is callable. Returns (sid, creditToken).
    function _activateWithCreditSlot() internal returns (uint256 sid, address creditToken) {
        sid = _openSeason();
        for (uint256 i = 0; i < 3; ++i) {
            address w = _wallet(i);
            vm.prank(w);
            launcher.reserve{value: _slotCost(uint64(i))}(_ticker(i), "ipfs://m");
        }
        address clubber = _wallet(3);
        _mintPass(clubber);
        vm.prank(clubber);
        launcher.reserve{value: 0}(_ticker(3), "ipfs://m");
        assertTrue(launcher.activated(sid));
        creditToken = launcher.tokensInSeason(sid)[3];

        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);
    }

    function test_ApplySoftFilter_ZeroStakeSurvivor_NoRevert() public {
        (uint256 sid, address creditToken) = _activateWithCreditSlot();
        LauncherStakeAdmin stakeAdmin = launcher.stakeAdmin();
        address clubber = _wallet(3);
        uint256 balBefore = clubber.balance;

        address[] memory survivors = new address[](1);
        survivors[0] = creditToken;
        address[] memory forfeited = new address[](0);

        // Zero-amount refund resolves cleanly: event fires with amount 0, no ETH moves.
        vm.expectEmit(true, true, true, true, address(stakeAdmin));
        emit LauncherStakeAdmin.StakeRefunded(sid, creditToken, clubber, 0);
        vm.prank(oracle);
        stakeAdmin.applySoftFilter(sid, survivors, forfeited);

        assertEq(clubber.balance, balBefore, "nothing to refund on a zero stake");
        IFilterLauncher.LaunchInfo memory info = launcher.launchInfoOf(sid, creditToken);
        assertTrue(info.refunded, "resolved as survivor");
        assertEq(info.stakeAmount, 0);
    }

    function test_ApplySoftFilter_ZeroStakeForfeit_NoRevert() public {
        (uint256 sid, address creditToken) = _activateWithCreditSlot();
        LauncherStakeAdmin stakeAdmin = launcher.stakeAdmin();
        address clubber = _wallet(3);
        uint256 treasuryBefore = treasury.balance;

        address[] memory survivors = new address[](0);
        address[] memory forfeited = new address[](1);
        forfeited[0] = creditToken;

        vm.expectEmit(true, true, true, true, address(stakeAdmin));
        emit LauncherStakeAdmin.StakeForfeited(sid, creditToken, clubber, 0);
        vm.prank(oracle);
        stakeAdmin.applySoftFilter(sid, survivors, forfeited);

        assertEq(treasury.balance, treasuryBefore, "no forfeit ETH from a zero stake");
        IFilterLauncher.LaunchInfo memory info = launcher.launchInfoOf(sid, creditToken);
        assertTrue(info.filteredEarly, "resolved as forfeited");
        assertEq(info.stakeAmount, 0);
    }

    // ============================================================ Fee mode

    function test_FeeMode_CreditLaunchForwardsZeroWithoutRevert() public {
        launcher.setLaunchConfig(0.05 ether, false); // fee mode: cost → forfeitRecipient at deploy
        uint256 sid = _openSeason();
        uint256 treasuryBefore = treasury.balance;

        uint256 paidTotal;
        for (uint256 i = 0; i < 3; ++i) {
            address w = _wallet(i);
            vm.prank(w);
            launcher.reserve{value: _slotCost(uint64(i))}(_ticker(i), "ipfs://m");
            paidTotal += _slotCost(uint64(i));
        }
        address clubber = _wallet(3);
        _mintPass(clubber); // pushes 0.05 ether mint proceeds to treasury too
        vm.prank(clubber);
        launcher.reserve{value: 0}(_ticker(3), "ipfs://m");

        assertTrue(launcher.activated(sid), "credit launch activates in fee mode");
        assertEq(launcher.launchCount(sid), 4);
        // Treasury got the three paid fees + the pass-mint proceeds; the credit slot
        // forwarded exactly 0 (the `amount > 0` guard skips the call — no revert).
        assertEq(treasury.balance - treasuryBefore, paidTotal + 0.05 ether);
        // Fee mode stakes nothing for anyone.
        for (uint256 i = 0; i < 4; ++i) {
            address t = launcher.tokensInSeason(sid)[i];
            assertEq(launcher.launchInfoOf(sid, t).stakeAmount, 0);
        }
        assertEq(address(launcher.stakeAdmin()).balance, 0, "no stake ETH held in fee mode");
    }
}
