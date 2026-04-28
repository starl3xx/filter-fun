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
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";

import {MockWETH} from "../mocks/MockWETH.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// @notice End-to-end V4-native settlement. Spins up a real PoolManager, deploys two tokens,
///         drives WETH into both via swaps, and runs `submitSettlement → liquidate → finalize
///         → claimRollover` through `SeasonVault` against the live V4 contracts. Closes the
///         test gap between the mock-based `WeeklyLifecycle` test and a real testnet deploy.
contract V4SettlementTest is Test, Deployers {
    FilterLauncher launcher;
    FilterFactory factory;
    FilterHook hook;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = makeAddr("oracle");
    address treasury = makeAddr("treasury");
    address mechanics = makeAddr("mechanics");
    address polRecipient = makeAddr("pol");

    address trader = makeAddr("trader");
    address holder = makeAddr("holder");

    function setUp() public {
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);

        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, polRecipient, IBonusFunding(address(bonus)), address(weth)
        );

        // Required hook flags: BEFORE_ADD_LIQUIDITY (1<<11) | BEFORE_REMOVE_LIQUIDITY (1<<9) = 0xA00.
        bytes memory hookCreationCode = type(FilterHook).creationCode;
        (address expectedHookAddr, bytes32 hookSalt) =
            HookMiner.find(address(this), uint160(0xA00), hookCreationCode);

        hook = new FilterHook{salt: hookSalt}();
        require(address(hook) == expectedHookAddr, "hook addr mismatch");

        factory = new FilterFactory(manager, hook, address(launcher), address(weth));
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

        // 4. Settlement.
        SeasonVault vault = SeasonVault(launcher.vaultOf(1));
        address[] memory losers = new address[](1);
        losers[0] = loserToken;
        uint256[] memory minOuts = new uint256[](1);

        vm.prank(oracle);
        vault.submitSettlement(winnerToken, losers, minOuts, root, 1, block.timestamp + 1 days);

        // 5. Liquidate the loser. Vault pulls WETH out of the loser pool via the locker.
        vault.liquidate(loserToken, 0);
        uint256 pot = weth.balanceOf(address(vault));
        assertGt(pot, 0, "pot should hold liquidated WETH");

        // 6. Finalize: vault distributes the pot per BPS — buys winner tokens with rollover
        //    + POL slices via the WINNER's locker.buyTokenWithWETH (which routes through the
        //    real V4 PoolManager swap path), and forwards bonus / treasury / mechanics slices.
        uint256 vaultWinnerBefore = IERC20(winnerToken).balanceOf(address(vault));
        uint256 polWinnerBefore = IERC20(winnerToken).balanceOf(polRecipient);
        vault.finalize(0, 0);

        // Phase advanced.
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Distributing));

        // Allocations landed in the right places.
        assertGt(weth.balanceOf(treasury), 0, "treasury got WETH");
        assertGt(weth.balanceOf(mechanics), 0, "mechanics got WETH");
        assertGt(weth.balanceOf(address(bonus)), 0, "bonus reserve funded");

        // Rollover bought winner tokens, held by the vault for Merkle claims.
        uint256 vaultWinnerAfter = IERC20(winnerToken).balanceOf(address(vault));
        assertGt(vaultWinnerAfter - vaultWinnerBefore, 0, "rollover bought winner tokens");
        assertEq(vault.rolloverWinnerTokens(), vaultWinnerAfter - vaultWinnerBefore);

        // POL bought winner tokens, sent to polRecipient.
        assertGt(IERC20(winnerToken).balanceOf(polRecipient) - polWinnerBefore, 0, "POL bought winner");

        // 7. Holder claims their full share. Single-leaf tree → empty proof.
        bytes32[] memory proof = new bytes32[](0);
        uint256 holderBefore = IERC20(winnerToken).balanceOf(holder);
        vm.prank(holder);
        vault.claimRollover(1, proof);
        uint256 holderAfter = IERC20(winnerToken).balanceOf(holder);
        // share=1 of total=1 → holder gets all rolloverWinnerTokens.
        assertEq(holderAfter - holderBefore, vault.rolloverWinnerTokens());
    }
}
