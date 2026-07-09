// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {FilterClubPass} from "../../src/FilterClubPass.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault} from "../../src/TournamentVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title ClubAbortReclaimTest
/// @notice Spec §47.3.8 sparse-week credit recovery (mirrors SparseWeekRefund's harness).
///         A credit spent into a season that never activates must be trustlessly restorable:
///         the escrow refunds the zero-value reservation (amount 0), and `reclaimCredit` —
///         callable by ANYONE — returns the credit to the TOKEN that paid it (so the pass's
///         current owner benefits, consistent with credits travelling on transfer). The
///         reclaim gate is the launcher's terminal `aborted` flag: live and activated
///         seasons both reject reclaim, so an eventually-deployed launch can never
///         double-spend its credit back.
contract ClubAbortReclaimTest is Test {
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

    function _mintPass(address who) internal returns (uint256 tokenId) {
        if (who.balance < 1 ether) vm.deal(who, 10 ether);
        vm.prank(who);
        clubPass.mint{value: 0.05 ether}(1);
        tokenId = clubPass.totalMinted();
    }

    function _abortAtH48(uint256 sid) internal {
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);
    }

    // ============================================================ Happy path

    function test_CreditReservation_AbortRefundsZero_ReclaimRestoresCredit() public {
        uint256 sid = _openSeason();
        address clubber = makeAddr("clubber");
        uint256 tokenId = _mintPass(clubber);

        vm.prank(clubber);
        launcher.reserve{value: 0}("SPARSE", "ipfs://s");
        assertEq(clubPass.creditsOf(tokenId), 1, "credit consumed at reserve");

        // h48: abort sweeps the escrow. The zero-value reservation refunds as amount 0.
        vm.warp(block.timestamp + 48 hours);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit LaunchEscrow.ReservationRefunded(sid, clubber, 0);
        vm.prank(oracle);
        launcher.abortSeason(sid);
        assertTrue(launcher.aborted(sid));
        assertTrue(escrow.escrowOf(sid, clubber).refunded, "zero-value row swept as refunded");

        // Reclaim restores the credit to the token.
        vm.expectEmit(true, true, true, true, address(clubPass));
        emit FilterClubPass.CreditReclaimed(tokenId, clubber, sid);
        clubPass.reclaimCredit(sid, clubber);

        assertEq(clubPass.creditsOf(tokenId), 2, "credit restored");
        assertEq(clubPass.consumedTokenOf(sid, clubber), 0, "record zeroed");
        assertEq(clubPass.creditsRemaining(clubber), 2);
    }

    // ============================================================ Reclaim guards

    function test_DoubleReclaim_RevertsNothingToReclaim() public {
        uint256 sid = _openSeason();
        address clubber = makeAddr("clubber");
        _mintPass(clubber);
        vm.prank(clubber);
        launcher.reserve{value: 0}("SPARSE", "ipfs://s");
        _abortAtH48(sid);

        clubPass.reclaimCredit(sid, clubber);
        vm.expectRevert(FilterClubPass.NothingToReclaim.selector);
        clubPass.reclaimCredit(sid, clubber);
    }

    function test_ReclaimOnLiveSeason_RevertsSeasonNotAborted() public {
        uint256 sid = _openSeason();
        address clubber = makeAddr("clubber");
        _mintPass(clubber);
        vm.prank(clubber);
        launcher.reserve{value: 0}("SPARSE", "ipfs://s");

        // Window still open, not aborted — no reclaim.
        vm.expectRevert(FilterClubPass.SeasonNotAborted.selector);
        clubPass.reclaimCredit(sid, clubber);
    }

    function test_ReclaimOnActivatedSeason_RevertsSeasonNotAborted() public {
        uint256 sid = _openSeason();
        address clubber = makeAddr("clubber");
        uint256 tokenId = _mintPass(clubber);

        // 3 paid + 1 credit = activation threshold; the cohort deploys.
        for (uint256 i = 0; i < 3; ++i) {
            address w = address(uint160(0xAB00) + uint160(i));
            vm.deal(w, 10 ether);
            string memory t = string(abi.encodePacked("AC", bytes1(uint8(65 + i)), bytes1(uint8(65 + i))));
            vm.prank(w);
            launcher.reserve{value: _slotCost(uint64(i))}(t, "ipfs://m");
        }
        vm.prank(clubber);
        launcher.reserve{value: 0}("ACTIV", "ipfs://a");
        assertTrue(launcher.activated(sid));

        // Even past the window, an activated season is never abortable, so the consumed
        // credit stays spent — its launch actually deployed.
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        vm.expectRevert(FilterLauncher.SeasonAlreadyActivated.selector);
        launcher.abortSeason(sid);

        vm.expectRevert(FilterClubPass.SeasonNotAborted.selector);
        clubPass.reclaimCredit(sid, clubber);
        assertEq(clubPass.creditsOf(tokenId), 1, "credit remains spent");
    }

    function test_ReclaimForPaidCreator_RevertsNothingToReclaim() public {
        uint256 sid = _openSeason();
        address paidCreator = makeAddr("paidCreator");
        address clubber = makeAddr("clubber");
        vm.deal(paidCreator, 10 ether);
        _mintPass(clubber);

        vm.prank(paidCreator);
        launcher.reserve{value: _slotCost(0)}("PAID", "ipfs://p");
        vm.prank(clubber);
        launcher.reserve{value: 0}("CRED", "ipfs://c");
        _abortAtH48(sid);

        // The paid creator got an ETH refund from the sweep, not a credit record.
        assertEq(paidCreator.balance, 10 ether, "paid creator made whole in ETH");
        vm.expectRevert(FilterClubPass.NothingToReclaim.selector);
        clubPass.reclaimCredit(sid, paidCreator);
    }

    // ============================================================ Credit-to-the-token semantics

    function test_TransferThenReclaim_NewOwnerBenefits() public {
        uint256 sid = _openSeason();
        address clubber = makeAddr("clubber");
        address buyer = makeAddr("buyer");
        uint256 tokenId = _mintPass(clubber);

        vm.prank(clubber);
        launcher.reserve{value: 0}("MOVED", "ipfs://m");
        assertEq(clubPass.creditsOf(tokenId), 1);

        // Pass sold mid-season — the pending credit record stays keyed to (season, creator),
        // but the credit itself is the token's.
        vm.prank(clubber);
        clubPass.transferFrom(clubber, buyer, tokenId);

        _abortAtH48(sid);
        clubPass.reclaimCredit(sid, clubber);

        assertEq(clubPass.creditsOf(tokenId), 2, "token made whole");
        assertEq(clubPass.creditsRemaining(buyer), 2, "current owner benefits");
        assertEq(clubPass.creditsRemaining(clubber), 0, "original consumer holds nothing");
    }

    function test_TwoCreditHolders_BothReclaimIndependently() public {
        uint256 sid = _openSeason();
        address clubberA = makeAddr("clubberA");
        address clubberB = makeAddr("clubberB");
        uint256 tokenA = _mintPass(clubberA);
        uint256 tokenB = _mintPass(clubberB);

        vm.prank(clubberA);
        launcher.reserve{value: 0}("CRDA", "ipfs://a");
        vm.prank(clubberB);
        launcher.reserve{value: 0}("CRDB", "ipfs://b");
        // 2 credit reservations < activation threshold → sparse season, aborts at h48.
        _abortAtH48(sid);

        clubPass.reclaimCredit(sid, clubberA);
        assertEq(clubPass.creditsOf(tokenA), 2, "A restored");
        assertEq(clubPass.creditsOf(tokenB), 1, "B untouched by A's reclaim");

        clubPass.reclaimCredit(sid, clubberB);
        assertEq(clubPass.creditsOf(tokenB), 2, "B restored independently");
    }

    function test_AnyoneCanReclaim() public {
        uint256 sid = _openSeason();
        address clubber = makeAddr("clubber");
        uint256 tokenId = _mintPass(clubber);
        vm.prank(clubber);
        launcher.reserve{value: 0}("HELP", "ipfs://h");
        _abortAtH48(sid);

        // A completely unrelated third party can trigger the reclaim — trustless, mirrors
        // the escrow's permissionless refund posture. The credit still lands on the token.
        address goodSamaritan = makeAddr("goodSamaritan");
        vm.prank(goodSamaritan);
        clubPass.reclaimCredit(sid, clubber);

        assertEq(clubPass.creditsOf(tokenId), 2);
        assertEq(clubPass.creditsRemaining(goodSamaritan), 0, "caller gains nothing");
    }
}
