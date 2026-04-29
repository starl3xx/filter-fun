// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {FilterFactory} from "../../src/FilterFactory.sol";
import {FilterHook} from "../../src/FilterHook.sol";
import {FilterLpLocker} from "../../src/FilterLpLocker.sol";
import {SeasonVault, IBonusFunding} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {POLVault} from "../../src/POLVault.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";

import {MockWETH} from "../mocks/MockWETH.sol";
import {HookMiner} from "../../src/libraries/HookMiner.sol";

/// @notice End-to-end V4-native settlement. Spins up a real PoolManager, deploys two tokens,
///         drives WETH into both via swaps, and runs `submitSettlement → liquidate → finalize
///         → claimRollover` through `SeasonVault` against the live V4 contracts. Closes the
///         test gap between the mock-based `WeeklyLifecycle` test and a real testnet deploy.
contract V4SettlementTest is Test, Deployers {
    FilterLauncher launcher;
    FilterFactory factory;
    FilterHook hook;
    BonusDistributor bonus;
    POLVault polVault;
    MockWETH weth;

    address owner = address(this);
    address oracle = makeAddr("oracle");
    address treasury = makeAddr("treasury");
    address mechanics = makeAddr("mechanics");
    address polVaultOwner = makeAddr("polVaultOwner");

    address trader = makeAddr("trader");
    address holder = makeAddr("holder");

    function setUp() public {
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        polVault = new POLVault(address(this));

        launcher = new FilterLauncher(
            owner,
            oracle,
            treasury,
            mechanics,
            address(polVault),
            IBonusFunding(address(bonus)),
            address(weth)
        );
        polVault.setLauncher(address(launcher));
        polVault.transferOwnership(polVaultOwner);

        // Required hook flags: BEFORE_ADD_LIQUIDITY (1<<11) | BEFORE_REMOVE_LIQUIDITY (1<<9) = 0xA00.
        bytes memory hookCreationCode = type(FilterHook).creationCode;
        (address expectedHookAddr, bytes32 hookSalt) =
            HookMiner.find(address(this), uint160(0xA00), hookCreationCode);

        hook = new FilterHook{salt: hookSalt}();
        require(address(hook) == expectedHookAddr, "hook addr mismatch");

        factory = new FilterFactory(
            manager, hook, address(launcher), address(weth), address(launcher.creatorFeeDistributor())
        );
        hook.initialize(address(factory));
        launcher.setFactory(IFilterFactory(address(factory)));

        vm.prank(oracle);
        launcher.startSeason();
    }

    /// @dev Helper: trader buys `wethIn` worth of `token` through the swap router.
    function _buyWithWETH(address token, uint256 wethIn) internal {
        PoolKey memory key = FilterLpLocker(launcher.lockerOf(1, token)).poolKey();
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

    function test_FullV4Settlement() public {
        // 1. Launch winner + loser. Both go through the same factory path against real V4.
        (address winnerToken,) = launcher.launchProtocolToken("Winner", "WIN", "");
        (address loserToken,) = launcher.launchProtocolToken("Loser", "LOSE", "");

        // 2. Trader puts WETH into both pools so each locker has WETH liquidity that
        //    finalize() and liquidate() can recover.
        weth.mint(trader, 2 ether);
        vm.prank(trader);
        weth.approve(address(swapRouter), type(uint256).max);
        _buyWithWETH(winnerToken, 0.4 ether);
        _buyWithWETH(loserToken, 0.4 ether);

        // 3. Build single-leaf rollover Merkle tree: holder gets 100% of the rollover slice.
        //    For a single leaf, leaf == root and the proof is empty.
        bytes32 leaf = keccak256(abi.encodePacked(holder, uint256(1)));
        bytes32 root = leaf;

        // 4. Filter event: cut the loser. The vault liquidates its LP and splits per BPS,
        //    accumulating rollover + bonus + POL as WETH. Mechanics + treasury get their
        //    cuts immediately.
        SeasonVault vault = SeasonVault(launcher.vaultOf(1));
        address[] memory losers = new address[](1);
        losers[0] = loserToken;
        uint256[] memory minOuts = new uint256[](1);

        uint256 mechanicsBefore = weth.balanceOf(mechanics);
        uint256 treasuryBefore = weth.balanceOf(treasury);

        vm.prank(oracle);
        vault.processFilterEvent(losers, minOuts);

        assertGt(vault.rolloverReserve(), 0, "rollover acc");
        assertGt(vault.bonusReserve(), 0, "bonus acc");
        assertGt(vault.polReserveBalance(), 0, "POL acc");
        assertGt(weth.balanceOf(mechanics) - mechanicsBefore, 0, "mechanics paid mid-event");
        assertGt(weth.balanceOf(treasury) - treasuryBefore, 0, "treasury paid mid-event");
        // POL stays as WETH — no winner-token purchase yet.
        assertEq(IERC20(winnerToken).balanceOf(address(polVault)), 0, "POL not deployed yet");

        // 5. Final settlement: oracle commits the winner. Vault drains rollover + bonus +
        //    POL reserves and buys winner tokens via the WINNER's locker (real V4 swap path).
        uint256 vaultWinnerBefore = IERC20(winnerToken).balanceOf(address(vault));
        vm.prank(oracle);
        vault.submitWinner(winnerToken, root, 1, 0, 0);

        // Phase advanced.
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Distributing));

        // Bonus reserve forwarded to BonusDistributor.
        assertGt(weth.balanceOf(address(bonus)), 0, "bonus distributor funded");

        // Rollover bought winner tokens, held by the vault for Merkle claims.
        uint256 vaultWinnerAfter = IERC20(winnerToken).balanceOf(address(vault));
        assertGt(vaultWinnerAfter - vaultWinnerBefore, 0, "rollover bought winner");
        assertEq(vault.rolloverWinnerTokens(), vaultWinnerAfter - vaultWinnerBefore);

        // POL deployed: WETH reserve drained, winner tokens parked in POLVault.
        assertEq(vault.polReserveBalance(), 0, "POL reserve drained");
        assertGt(IERC20(winnerToken).balanceOf(address(polVault)), 0, "POL deployed to vault");
        assertEq(polVault.seasonDeposit(1), vault.polDeployedTokens());

        // 6. Holder claims their full share. Single-leaf tree → empty proof.
        bytes32[] memory proof = new bytes32[](0);
        uint256 holderBefore = IERC20(winnerToken).balanceOf(holder);
        vm.prank(holder);
        vault.claimRollover(1, proof);
        uint256 holderAfter = IERC20(winnerToken).balanceOf(holder);
        // share=1 of total=1 → holder gets all rolloverWinnerTokens.
        assertEq(holderAfter - holderBefore, vault.rolloverWinnerTokens());
    }
}
