// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {FilterClubPass} from "../../src/FilterClubPass.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault, ITournamentRegistryView, ICreatorRegistryView} from "../../src/TournamentVault.sol";
import {FilterFactory} from "../../src/FilterFactory.sol";
import {FilterHook} from "../../src/FilterHook.sol";
import {FilterLpLocker} from "../../src/FilterLpLocker.sol";
import {SeasonVault, IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {POLVault} from "../../src/POLVault.sol";
import {POLManager, IPOLVaultRecord} from "../../src/POLManager.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../../src/interfaces/IFilterLauncher.sol";

import {MockWETH} from "../mocks/MockWETH.sol";
import {HookMiner} from "../../src/libraries/HookMiner.sol";

/// @notice Filter Club end-to-end on REAL local V4 (spec §47.3.8 / Epic 2.6). Mirrors
///         WeeklyLifecycle's season beats on the V4Settlement harness: two creators mint
///         lifetime passes and reserve with credits (msg.value == 0), two more pay — the
///         4th reservation (a credit one) crosses the activation threshold and deploys all
///         four tokens with live pools. Traders swap, the oracle liquidates losers through
///         real lockers, and settlement (rollover buy + POL deploy + bounty) completes with
///         a CREDIT-LAUNCHED token as the winner. The property under test: once deployed, a
///         credit launch is indistinguishable from a paid one everywhere downstream.
contract ClubLifecycleTest is Test, Deployers {
    FilterLauncher launcher;
    FilterClubPass clubPass;
    FilterFactory factory;
    FilterHook hook;
    BonusDistributor bonus;
    POLVault polVault;
    POLManager polManager;
    MockWETH weth;

    address owner = address(this);
    address oracle = makeAddr("oracle");
    address treasury = makeAddr("treasury");
    address mechanics = makeAddr("mechanics");
    address polVaultOwner = makeAddr("polVaultOwner");

    // Two Filter Club members (credit launches) + two paying creators.
    address clubber1 = makeAddr("clubber1");
    address clubber2 = makeAddr("clubber2");
    address payer1 = makeAddr("payer1");
    address payer2 = makeAddr("payer2");

    address trader = makeAddr("trader");
    address holder = makeAddr("holder");

    uint256 sid;

    function setUp() public {
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        polVault = new POLVault(address(this));

        clubPass = new FilterClubPass(owner, treasury, "ipfs://club/", 250, 0.05 ether, 5);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth), clubPass
        );
        clubPass.setLauncher(address(launcher));
        polManager = new POLManager(address(launcher), address(weth), IPOLVaultRecord(address(polVault)));
        polVault.setPolManager(address(polManager));
        polVault.transferOwnership(polVaultOwner);

        // Required hook flags: BEFORE_ADD_LIQUIDITY (1<<11) | BEFORE_REMOVE_LIQUIDITY (1<<9) = 0xA00.
        bytes memory hookCreationCode = type(FilterHook).creationCode;
        (address expectedHookAddr, bytes32 hookSalt) =
            HookMiner.find(address(this), uint160(0xA00), hookCreationCode);

        hook = new FilterHook{salt: hookSalt}();
        require(address(hook) == expectedHookAddr, "hook addr mismatch");

        factory = new FilterFactory(
            manager,
            hook,
            address(launcher),
            address(weth),
            address(launcher.creatorFeeDistributor()),
            address(polManager),
            launcher.creatorCommitments()
        );
        hook.initialize(address(factory));
        // Tournament contracts are externalised (EIP-3860 budget); one-shot wire once all
        // four external deps exist.
        {
            TournamentRegistry tr = new TournamentRegistry(address(launcher));
            TournamentVault tv = new TournamentVault(
                address(launcher),
                address(weth),
                treasury,
                mechanics,
                ITournamentRegistryView(address(tr)),
                ICreatorRegistryView(address(launcher.creatorRegistry())),
                launcher.bonusUnlockDelay()
            );
            launcher.wire(IFilterFactory(address(factory)), IPOLManager(address(polManager)), tr, tv);
        }

        vm.prank(oracle);
        sid = launcher.startSeason();

        vm.deal(clubber1, 10 ether);
        vm.deal(clubber2, 10 ether);
        vm.deal(payer1, 10 ether);
        vm.deal(payer2, 10 ether);
    }

    /// @dev Trader buys `wethIn` worth of `token` through the live V4 swap router.
    function _buyWithWETH(address token, uint256 wethIn) internal {
        PoolKey memory key = FilterLpLocker(launcher.lockerOf(sid, token)).poolKey();
        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = !tokenIsZero; // input is WETH
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(wethIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Reservation block shared by both tests. Slot order (== tokensInSeason order):
    ///        0 CWIN  — clubber1, CREDIT
    ///        1 PLOSE — payer1, paid
    ///        2 PSURV — payer2, paid
    ///        3 CLOSE — clubber2, CREDIT (4th reservation → activation moment)
    ///      Returns the deployed token addresses in slot order.
    function _mintPassesAndActivate() internal returns (address[] memory tokens) {
        // Day 1: two founding members mint their lifetime passes (proceeds push to treasury).
        vm.prank(clubber1);
        clubPass.mint{value: 0.05 ether}(1); // tokenId 1
        vm.prank(clubber2);
        clubPass.mint{value: 0.05 ether}(1); // tokenId 2
        assertEq(treasury.balance, 0.1 ether, "mint proceeds pushed per-mint");

        // Pre-compute paid slot costs outside the prank pairs (lens call would eat a prank).
        uint256 c1 = launcher.lens().launchCost(1);
        uint256 c2 = launcher.lens().launchCost(2);

        // Day 1-2: reservations. Credit first (msg.value == 0 is the credit-intent signal).
        vm.prank(clubber1);
        launcher.reserve{value: 0}("CWIN", "ipfs://cwin");
        vm.prank(payer1);
        launcher.reserve{value: c1}("PLOSE", "ipfs://plose");
        vm.prank(payer2);
        launcher.reserve{value: c2}("PSURV", "ipfs://psurv");
        assertEq(launcher.launchCount(sid), 0, "nothing deployed pre-threshold");

        // The 4th reservation — ALSO a credit launch — crosses the activation threshold and
        // deploys the whole cohort against live V4 in this tx.
        vm.prank(clubber2);
        launcher.reserve{value: 0}("CLOSE", "ipfs://close");

        assertTrue(launcher.activated(sid), "credit reservation activated the season");
        tokens = launcher.tokensInSeason(sid);
        assertEq(tokens.length, 4, "all four deployed atomically");

        // Both passes consumed exactly one credit each.
        assertEq(clubPass.creditsOf(1), 1);
        assertEq(clubPass.creditsOf(2), 1);
        assertEq(clubPass.redemptionsInSeason(sid), 2);

        // Zero stake for credit slots; real stake for paid slots — recorded on stakeAdmin.
        assertEq(launcher.launchInfoOf(sid, tokens[0]).stakeAmount, 0, "credit slot 0: zero stake");
        assertEq(launcher.launchInfoOf(sid, tokens[3]).stakeAmount, 0, "credit slot 3: zero stake");
        assertEq(launcher.launchInfoOf(sid, tokens[1]).stakeAmount, uint128(c1), "paid slot 1 staked");
        assertEq(launcher.launchInfoOf(sid, tokens[2]).stakeAmount, uint128(c2), "paid slot 2 staked");
        assertEq(address(launcher.launchEscrow()).balance, 0, "escrow fully released");
    }

    /// @notice Full week on real V4 with a credit-launched WINNER. Mirrors WeeklyLifecycle's
    ///         beats: activate → trade → filter cuts (one credit + one paid loser liquidate
    ///         identically) → settlement (bounty to the club creator, rollover buys the
    ///         credit-launched winner, POL LP minted on its pool) → holder claims.
    function test_FullWeek_CreditWinner() public {
        address[] memory tokens = _mintPassesAndActivate();
        address creditWinner = tokens[0]; // CWIN  (credit, clubber1)
        address paidLoser = tokens[1]; //    PLOSE (paid,   payer1)
        address paidSurvivor = tokens[2]; // PSURV (paid,   payer2)
        address creditLoser = tokens[3]; //  CLOSE (credit, clubber2)

        // Every deployed token has a live locker with a seeded V4 pool.
        for (uint256 i = 0; i < 4; ++i) {
            FilterLpLocker locker = FilterLpLocker(launcher.lockerOf(sid, tokens[i]));
            assertEq(locker.token(), tokens[i], "locker wired to its token");
            assertEq(IERC20(tokens[i]).totalSupply(), 1_000_000_000 ether);
        }

        // Day 2-3: traders buy into winner + both losers so the pools hold WETH for the
        // filter events and settlement to recover. Credit pools trade like paid pools.
        weth.mint(trader, 3 ether);
        vm.prank(trader);
        weth.approve(address(swapRouter), type(uint256).max);
        _buyWithWETH(creditWinner, 0.4 ether);
        _buyWithWETH(paidLoser, 0.4 ether);
        _buyWithWETH(creditLoser, 0.4 ether);
        assertGt(IERC20(creditWinner).balanceOf(trader), 0, "credit pool sold tokens to trader");

        // Day 3: oracle advances to Filter and cuts one credit-launched and one paid token in
        // the same event — both liquidate through their real lockers.
        vm.warp(block.timestamp + 2 days);
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);

        SeasonVault vault = SeasonVault(launcher.vaultOf(sid));
        address[] memory losers = new address[](2);
        losers[0] = creditLoser;
        losers[1] = paidLoser;
        uint256[] memory minOuts = new uint256[](2);
        vm.prank(oracle);
        vault.processFilterEvent(losers, minOuts);

        assertTrue(vault.liquidated(creditLoser), "credit loser liquidated");
        assertTrue(vault.liquidated(paidLoser), "paid loser liquidated");
        assertGt(vault.rolloverReserve(), 0, "losers-pot rollover accumulated");
        assertGt(vault.bonusReserve(), 0, "bonus accumulated");
        assertGt(vault.bountyReserve(), 0, "champion bounty accumulated");
        assertGt(vault.polReserveBalance(), 0, "POL accumulated");
        assertGt(weth.balanceOf(mechanics), 0, "mechanics paid mid-week");
        assertGt(weth.balanceOf(treasury), 0, "treasury paid mid-week");

        // Day 4-7: Finals then Settlement.
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Finals);
        vm.warp(block.timestamp + 4 days);
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Settlement);

        // Single-leaf rollover tree: holder owns 100% of the shares (leaf == root, empty proof).
        bytes32 root = keccak256(abi.encodePacked(holder, uint256(1)));

        // THE headline: the CREDIT-LAUNCHED token wins the week.
        uint256 clubber1WethBefore = weth.balanceOf(clubber1);
        vm.prank(oracle);
        vault.submitWinner(creditWinner, root, 1, 0, 0);

        // Champion bounty routed to the credit launch's creator — the registry recorded
        // clubber1 at deploy time exactly as it would a paying creator.
        assertEq(vault.bountyRecipient(), clubber1, "bounty goes to the club member");
        assertGt(weth.balanceOf(clubber1) - clubber1WethBefore, 0, "bounty paid in WETH");

        // Rollover bought real winner tokens through the winner's locker (live V4 swap).
        assertGt(vault.rolloverWinnerTokens(), 0, "rollover bought the credit winner");
        assertEq(IERC20(creditWinner).balanceOf(address(vault)), vault.rolloverWinnerTokens());

        // POL deployed into the credit winner's pool — real V4 liquidity minted.
        assertEq(vault.polReserveBalance(), 0, "POL reserve drained");
        assertEq(polVault.deploymentCount(), 1);
        POLVault.Deployment memory dep = polVault.deploymentOf(1);
        assertEq(dep.winner, creditWinner);
        assertGt(dep.liquidity, 0, "real V4 POL liquidity on the credit winner");
        assertEq(
            FilterLpLocker(launcher.lockerOf(sid, creditWinner)).polLiquidity(),
            dep.liquidity,
            "locker holds the POL position"
        );

        // Winner ticker permanently reserved cross-season under its canonical hash.
        assertEq(launcher.winnerTickers(keccak256("CWIN")), creditWinner);

        // Bonus reserve forwarded to the distributor.
        assertGt(weth.balanceOf(address(bonus)), 0, "bonus distributor funded");

        // Holder claims the full rollover (share 1 of 1, empty proof).
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(holder);
        vault.claimRollover(1, proof);
        assertEq(IERC20(creditWinner).balanceOf(holder), vault.rolloverWinnerTokens());

        // The surviving paid token was never touched — parity in the other direction.
        assertFalse(vault.liquidated(paidSurvivor));

        // Credits stay spent (season activated — nothing reclaimable) and the pass holds no ETH.
        assertEq(clubPass.creditsOf(1), 1);
        assertEq(clubPass.creditsOf(2), 1);
        assertEq(address(clubPass).balance, 0);
    }

    /// @notice Variant: a PAID token wins while BOTH credit launches are cut — the credit
    ///         tokens liquidate through the same real-V4 path as any paid loser, and their
    ///         proceeds fund the paid winner's settlement identically.
    function test_FullWeek_PaidWinner_CreditLosersLiquidateIdentically() public {
        address[] memory tokens = _mintPassesAndActivate();
        address creditLoserA = tokens[0]; // CWIN  (credit) — loses this time
        address paidWinner = tokens[1]; //   PLOSE (paid)   — wins this time
        address creditLoserB = tokens[3]; // CLOSE (credit)

        weth.mint(trader, 3 ether);
        vm.prank(trader);
        weth.approve(address(swapRouter), type(uint256).max);
        _buyWithWETH(paidWinner, 0.4 ether);
        _buyWithWETH(creditLoserA, 0.4 ether);
        _buyWithWETH(creditLoserB, 0.4 ether);

        vm.warp(block.timestamp + 2 days);
        vm.prank(oracle);
        launcher.advancePhase(sid, IFilterLauncher.Phase.Filter);

        // Two filter events, one credit loser each — exercises multi-event accumulation with
        // zero-stake tokens in both.
        SeasonVault vault = SeasonVault(launcher.vaultOf(sid));
        address[] memory losers1 = new address[](1);
        losers1[0] = creditLoserA;
        uint256[] memory minOuts1 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(losers1, minOuts1);
        uint256 rolloverAfterFirst = vault.rolloverReserve();
        assertGt(rolloverAfterFirst, 0, "credit loser A produced proceeds");

        address[] memory losers2 = new address[](1);
        losers2[0] = creditLoserB;
        uint256[] memory minOuts2 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(losers2, minOuts2);
        assertGt(vault.rolloverReserve(), rolloverAfterFirst, "credit loser B accumulated on top");

        // Settle on the paid winner; credit-sourced proceeds flow through unchanged.
        bytes32 root = keccak256(abi.encodePacked(holder, uint256(1)));
        vm.prank(oracle);
        vault.submitWinner(paidWinner, root, 1, 0, 0);

        assertEq(vault.bountyRecipient(), payer1, "paid creator takes the bounty");
        assertGt(vault.rolloverWinnerTokens(), 0);
        assertEq(polVault.deploymentCount(), 1);

        bytes32[] memory proof = new bytes32[](0);
        vm.prank(holder);
        vault.claimRollover(1, proof);
        assertEq(IERC20(paidWinner).balanceOf(holder), vault.rolloverWinnerTokens());
    }
}
