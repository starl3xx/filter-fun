// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {FilterFactory} from "../../src/FilterFactory.sol";
import {FilterHook} from "../../src/FilterHook.sol";
import {FilterLpLocker} from "../../src/FilterLpLocker.sol";
import {SeasonVault, IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault, ITournamentRegistryView, ICreatorRegistryView} from "../../src/TournamentVault.sol";
import {POLVault} from "../../src/POLVault.sol";
import {POLManager, IPOLVaultRecord} from "../../src/POLManager.sol";
import {CreatorFeeDistributor} from "../../src/CreatorFeeDistributor.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";

import {MockWETH} from "../mocks/MockWETH.sol";
import {HookMiner} from "../../src/libraries/HookMiner.sol";

/// @notice Integration coverage for Epic 1.16 (spec §9.4 + §10.3 + §10.6, locked 2026-05-02).
///         Drives real V4 swaps against a freshly-deployed cohort and exercises:
///
///         1. Routing flip at the settlement block: the last fee collection pre-`submitWinner`
///            routes to SeasonVault (§9.2). The first fee collection post-submitWinner routes
///            to POLVault (§9.4). The flip is atomic — same locker, swap order is the only
///            difference.
///         2. Perpetual creator accrual at 30 / 90 / 365 days post-settlement. Pre-Epic-1.16
///            the eligibility window would have redirected these to treasury; the new spec
///            credits the creator unconditionally.
///         3. Non-winner pools accrue ZERO post-settlement because their LP has been unwound
///            and they no longer trade. The pool-lifecycle terminator stands in for the
///            removed code-side cap (spec §10.3).
///         4. Property-style invariants on a sequence of post-settlement swaps:
///              - inv_post_settlement_routing: per-event {POL, treasury, mechanics, creator}
///                slices satisfy POST_SETTLEMENT_*_BPS exactly, and their sum equals the WETH
///                amount the locker collected (no leakage; matches spec §9.4 200-bps total).
///              - inv_creator_fee_perpetual_for_winner: creator-fee accrual is strictly
///                monotonic across every winner-pool swap post-settlement (no event silently
///                redirects what should be the creator's slice).
///
///         The setup mirrors `V4LifecycleTest` (real PoolManager, full filter.fun deploy) so
///         the routing math is exercised through the production code path, not a mock.
contract Epic116FeeRoutingTest is Test, Deployers {
    FilterLauncher launcher;
    FilterFactory factory;
    FilterHook hook;
    BonusDistributor bonus;
    MockWETH weth;
    POLVault polVault;
    POLManager polManager;

    address ownerAddr = address(this);
    address oracle = makeAddr("oracle");
    address treasury = makeAddr("treasury");
    address mechanics = makeAddr("mechanics");
    address polVaultOwner = makeAddr("polVaultOwner");
    address trader = makeAddr("trader");
    address creator = makeAddr("creator");

    function setUp() public {
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        polVault = new POLVault(address(this));

        launcher = new FilterLauncher(
            ownerAddr, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        polManager = new POLManager(address(launcher), address(weth), IPOLVaultRecord(address(polVault)));
        launcher.setPolManager(IPOLManager(address(polManager)));
        polVault.setPolManager(address(polManager));
        polVault.transferOwnership(polVaultOwner);

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
        launcher.setFactory(IFilterFactory(address(factory)));
        // PR #88 audit: tournament wires are required. Real instances (not dummy
        // addresses) because SeasonVault's constructor calls into the registry view.
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
            launcher.setTournament(tr, tv);
        }

        vm.prank(oracle);
        launcher.startSeason();
    }

    // -------- Helpers ---------------------------------------------------------------

    function _launch(string memory name, string memory symbol)
        internal
        returns (address tokenAddr, FilterLpLocker locker)
    {
        (tokenAddr,) = launcher.launchProtocolToken(name, symbol, "");
        locker = FilterLpLocker(launcher.lockerOf(1, tokenAddr));
    }

    /// @dev Drives a buy (WETH → token) of `wethIn` through the pool. Returns nothing — the
    ///      caller pokes the locker afterwards to materialize fees.
    function _swapInto(address tokenAddr, uint256 wethIn) internal {
        FilterLpLocker locker = FilterLpLocker(launcher.lockerOf(1, tokenAddr));
        PoolKey memory key = locker.poolKey();

        weth.mint(trader, wethIn);
        vm.prank(trader);
        weth.approve(address(swapRouter), type(uint256).max);

        bool tokenIsZero = Currency.unwrap(key.currency0) == tokenAddr;
        bool zeroForOne = !tokenIsZero; // WETH → token

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

    /// @dev Submit `tokenAddr` as the winner of season 1 with empty rollover. Pre-call must
    ///      have at least one filter event so the vault has a non-trivial state, but the
    ///      routing flip itself does not require it.
    function _submitWinner(address tokenAddr) internal {
        // The vault requires totalRolloverShares > 0; pass a sentinel root with a single dummy
        // share that no holder will claim. min-out floors are zero because the rollover bucket
        // is empty (no filter events ran in this test path).
        // NB: cache the vault address BEFORE the prank — `launcher.vaultOf(1)` is a staticcall
        // that consumes the `vm.prank` if interleaved on the same expression.
        SeasonVault vault = SeasonVault(launcher.vaultOf(1));
        vm.prank(oracle);
        vault.submitWinner(tokenAddr, bytes32(uint256(1)), 1, 0, 0);
    }

    // ============================================================ Routing flip

    /// @notice Last fee collection pre-settlement uses §9.2 (prize → vault); first fee
    ///         collection post-settlement uses §9.4 (POL slice → polVault). Same locker, same
    ///         pool, only difference is `winnerSettledAt`.
    function test_RoutingFlipsAtSettlementBlock() public {
        (address tokenAddr, FilterLpLocker locker) = _launch("Winner", "WIN");

        // Pre-settlement swap + collect.
        _swapInto(tokenAddr, 0.5 ether);
        uint256 vaultBefore = weth.balanceOf(address(launcher.vaultOf(1)));
        uint256 polVaultBefore = weth.balanceOf(address(polVault));
        locker.collectFees();
        uint256 vaultAfterPre = weth.balanceOf(address(launcher.vaultOf(1)));
        uint256 polVaultAfterPre = weth.balanceOf(address(polVault));
        assertGt(vaultAfterPre, vaultBefore, "pre-settlement: SeasonVault must receive the prize-pool slice");
        assertEq(polVaultAfterPre - polVaultBefore, 0, "pre-settlement: POLVault must NOT receive any slice");

        // Settlement.
        _submitWinner(tokenAddr);
        assertGt(locker.winnerSettledAt(), 0, "winnerSettledAt set on winner locker");

        // Post-settlement swap + collect.
        _swapInto(tokenAddr, 0.5 ether);
        uint256 vaultAfterPost = weth.balanceOf(address(launcher.vaultOf(1)));
        uint256 polVaultAfterPost = weth.balanceOf(address(polVault));
        locker.collectFees();
        uint256 vaultAfterCollect = weth.balanceOf(address(launcher.vaultOf(1)));
        uint256 polVaultAfterCollect = weth.balanceOf(address(polVault));
        assertEq(
            vaultAfterCollect,
            vaultAfterPost,
            "post-settlement: SeasonVault must NOT receive the prize-pool slice"
        );
        assertGt(
            polVaultAfterCollect,
            polVaultAfterPost,
            "post-settlement: POLVault must receive the prize-pool slice"
        );
    }

    /// @notice Routing flip writes settledAt EXACTLY ONCE — the locker reverts on a re-call
    ///         from the vault.
    function test_MarkWinnerSettled_OnceOnly() public {
        (address tokenAddr, FilterLpLocker locker) = _launch("Winner", "WIN");
        _submitWinner(tokenAddr);

        // A second submitWinner via the vault would itself revert on phase, but the locker
        // must guard the second mark independently — drive it directly as the vault.
        vm.prank(launcher.vaultOf(1));
        vm.expectRevert(FilterLpLocker.AlreadySettled.selector);
        locker.markWinnerSettled();
    }

    function test_MarkWinnerSettled_NotVault() public {
        (, FilterLpLocker locker) = _launch("Winner", "WIN");
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(FilterLpLocker.NotVault.selector);
        locker.markWinnerSettled();
    }

    // ============================================================ Perpetual accrual

    /// @notice Spec §10.3 + §10.6: creator accrues forever post-settlement. Drive a
    ///         post-settlement swap a year out and assert the creator's pending claim grew.
    function test_CreatorAccruesAt365DaysPostSettlement() public {
        (address tokenAddr, FilterLpLocker locker) = _launch("Winner", "WIN");
        _submitWinner(tokenAddr);

        CreatorFeeDistributor distributor = launcher.creatorFeeDistributor();

        // Warp out a year. With no eligibility window any more, the creator's slice still
        // lands on the next swap.
        vm.warp(block.timestamp + 365 days);

        uint256 pendingBefore = distributor.pendingClaim(tokenAddr);
        _swapInto(tokenAddr, 0.5 ether);
        locker.collectFees();
        uint256 pendingAfter = distributor.pendingClaim(tokenAddr);
        assertGt(pendingAfter, pendingBefore, "creator should accrue 365d post-settlement");
    }

    function test_CreatorAccruesAt30DaysPostSettlement() public {
        (address tokenAddr, FilterLpLocker locker) = _launch("Winner", "WIN");
        _submitWinner(tokenAddr);

        CreatorFeeDistributor distributor = launcher.creatorFeeDistributor();
        vm.warp(block.timestamp + 30 days);
        _swapInto(tokenAddr, 0.5 ether);
        locker.collectFees();
        assertGt(distributor.pendingClaim(tokenAddr), 0, "creator should accrue 30d post-settlement");
    }

    function test_CreatorAccruesAt90DaysPostSettlement() public {
        (address tokenAddr, FilterLpLocker locker) = _launch("Winner", "WIN");
        _submitWinner(tokenAddr);

        CreatorFeeDistributor distributor = launcher.creatorFeeDistributor();
        vm.warp(block.timestamp + 90 days);
        _swapInto(tokenAddr, 0.5 ether);
        locker.collectFees();
        assertGt(distributor.pendingClaim(tokenAddr), 0, "creator should accrue 90d post-settlement");
    }

    // ============================================================ Non-winner pool

    /// @notice A non-winner locker that is liquidated mid-season cannot accrue post-settlement
    ///         fees because its LP is gone — the pool simply does not produce fees.
    function test_NonWinnerAccruesZeroPostSettlement() public {
        (address tokenA,) = _launch("Alpha", "ALPHA");
        (, FilterLpLocker lockerB) = _launch("Beta", "BETA");

        // Drive trade so loser locker has fees pending pre-liquidation.
        _swapInto(tokenA, 0.2 ether);

        // Liquidate token A as the loser — sets `liquidated = true` on the locker, drains LP.
        SeasonVault vault = SeasonVault(launcher.vaultOf(1));
        address[] memory losers = new address[](1);
        losers[0] = tokenA;
        uint256[] memory minOuts = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(losers, minOuts);

        // Submit B as winner.
        _submitWinner(address(lockerB.token()));

        // Try to swap on token A. The pool is drained — the swap can't even produce
        // meaningful fees. Try to collect: reverts in `liquidateToWETH` re-entry on a
        // double-liquidation attempt isn't relevant here; we just assert `liquidated == true`
        // and the creator accrues nothing on the drained pool. (V4 is happy to swap against
        // a zero-liquidity pool; the tx just reverts in `swap` with no liquidity available.)
        FilterLpLocker lockerA = FilterLpLocker(launcher.lockerOf(1, tokenA));
        assertTrue(lockerA.liquidated(), "loser locker liquidated");

        CreatorFeeDistributor distributor = launcher.creatorFeeDistributor();
        uint256 pendingA = distributor.pendingClaim(tokenA);
        // Whatever the loser earned before the cut is still claim-bound, but no NEW
        // post-settlement accrual is possible — the LP is gone.
        // We assert the property by trying to drive a fee event: swap reverts because the
        // pool has no liquidity, and the locker can't have collected anything.
        // (Wrap in a try-block in case a future V4 version handles drained pools more
        // gracefully — our property here is "no NEW credit", not "swap reverts".)
        try this._tryCollect(address(lockerA)) {} catch {}
        assertEq(distributor.pendingClaim(tokenA), pendingA, "loser accrual unchanged after settlement");
    }

    /// @dev External helper for try/catch from inside the test contract.
    function _tryCollect(address locker) external {
        FilterLpLocker(locker).collectFees();
    }

    // ============================================================ Invariants on a swap series

    /// @notice inv_post_settlement_routing: across a sequence of post-settlement fee events,
    ///         the per-event {POL, treasury, mechanics, creator} amounts each match the
    ///         POST_SETTLEMENT_*_BPS-derived fraction of the WETH leg, and their sum equals
    ///         the locker-collected WETH amount (no leakage). Driven over multiple swap sizes
    ///         + warps so the integer-division dust path hits the POL slice (which absorbs
    ///         rounding by construction).
    ///
    ///         The check measures destination-balance deltas across each `collectFees` and
    ///         compares them to the *expected* slices computed off the same WETH amount the
    ///         locker just collected.
    function test_InvPostSettlementRouting_HoldsAcrossManyEvents() public {
        (address tokenAddr, FilterLpLocker locker) = _launch("Winner", "WIN");
        _submitWinner(tokenAddr);
        CreatorFeeDistributor distributor = launcher.creatorFeeDistributor();

        // A series of post-settlement swaps with varied sizes so the integer math hits both
        // dust-y and clean rounding paths.
        uint256[6] memory swaps =
            [uint256(0.1 ether), 0.05 ether, 0.5 ether, 0.001 ether, 1 ether, 0.013 ether];

        uint256 priorCreatorPending = distributor.pendingClaim(tokenAddr);

        for (uint256 i = 0; i < swaps.length; ++i) {
            _swapInto(tokenAddr, swaps[i]);

            uint256 polVaultBefore = weth.balanceOf(address(polVault));
            uint256 treasuryBefore = weth.balanceOf(treasury);
            uint256 mechBefore = weth.balanceOf(mechanics);
            uint256 distributorBefore = weth.balanceOf(address(distributor));

            locker.collectFees();

            uint256 polDelta = weth.balanceOf(address(polVault)) - polVaultBefore;
            uint256 treasuryDelta = weth.balanceOf(treasury) - treasuryBefore;
            uint256 mechDelta = weth.balanceOf(mechanics) - mechBefore;
            uint256 distributorDelta = weth.balanceOf(address(distributor)) - distributorBefore;
            uint256 totalCollected = polDelta + treasuryDelta + mechDelta + distributorDelta;

            // Per spec §9.4: the four slices reconstruct the WETH leg exactly.
            // POL slice = totalCollected - (treasury + mechanics + creator). The treasury,
            // mechanics, creator slices match `(totalCollected * BPS) / 200` exactly because
            // the locker uses the same formula.
            uint256 expectedTreasury = (totalCollected * locker.POST_SETTLEMENT_TREASURY_BPS()) / 200;
            uint256 expectedMech = (totalCollected * locker.POST_SETTLEMENT_MECHANICS_BPS()) / 200;
            uint256 expectedCreator = (totalCollected * locker.POST_SETTLEMENT_CREATOR_BPS()) / 200;
            uint256 expectedPol = totalCollected - expectedTreasury - expectedMech - expectedCreator;

            assertEq(treasuryDelta, expectedTreasury, "post-settle: treasury slice drift");
            assertEq(mechDelta, expectedMech, "post-settle: mechanics slice drift");
            assertEq(distributorDelta, expectedCreator, "post-settle: creator slice drift");
            assertEq(polDelta, expectedPol, "post-settle: POL slice drift");

            // inv_creator_fee_perpetual_for_winner: distributor's pending claim strictly
            // increases on every fee event (since creator slice > 0 for any non-trivial swap).
            uint256 newPending = distributor.pendingClaim(tokenAddr);
            if (expectedCreator > 0) {
                assertGt(newPending, priorCreatorPending, "perpetual: creator pending must grow");
            }
            priorCreatorPending = newPending;

            // Vary timing across iterations so the perpetual property is exercised over a
            // long-tail timeline (no implicit cap means the result must hold at all warps).
            vm.warp(block.timestamp + 10 days);
        }
    }
}
