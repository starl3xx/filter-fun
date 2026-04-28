// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {FilterFactory} from "../../src/FilterFactory.sol";
import {FilterHook} from "../../src/FilterHook.sol";
import {FilterLpLocker} from "../../src/FilterLpLocker.sol";
import {SeasonVault, IBonusFunding} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IFilterLauncher} from "../../src/interfaces/IFilterLauncher.sol";

import {MockUSDC} from "../mocks/MockUSDC.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// @notice End-to-end V4 integration: spins up a real PoolManager, mines the hook salt,
///         deploys the full filter.fun suite, and exercises the deployment + LP + swap +
///         locker primitives against the live V4 contracts.
contract V4LifecycleTest is Test, Deployers {
    using StateLibrary for IPoolManager;

    FilterLauncher launcher;
    FilterFactory factory;
    FilterHook hook;
    BonusDistributor bonus;
    MockUSDC usdc;

    address owner = address(this);
    address oracle = makeAddr("oracle");
    address treasury = makeAddr("treasury");
    address mechanics = makeAddr("mechanics");
    address polRecipient = makeAddr("pol");

    address trader = makeAddr("trader");

    function setUp() public {
        // Boot V4 PoolManager + helpers (sets `manager`, swap router, etc).
        deployFreshManagerAndRouters();

        usdc = new MockUSDC();
        bonus = new BonusDistributor(address(0), address(usdc), oracle);

        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, polRecipient, IBonusFunding(address(bonus)), address(usdc)
        );

        // Mine hook salt for required flags = BEFORE_ADD_LIQUIDITY (1<<11) | BEFORE_REMOVE_LIQUIDITY (1<<9) = 0xA00.
        bytes memory hookCreationCode = type(FilterHook).creationCode;
        (address expectedHookAddr, bytes32 hookSalt) =
            HookMiner.find(address(this), uint160(0xA00), hookCreationCode);

        hook = new FilterHook{salt: hookSalt}();
        require(address(hook) == expectedHookAddr, "hook addr mismatch");

        factory = new FilterFactory(manager, hook, address(launcher), address(usdc));
        hook.initialize(address(factory));
        launcher.setFactory(IFilterFactory(address(factory)));

        // Open Season 1.
        vm.prank(oracle);
        launcher.startSeason();
    }

    function test_LaunchTokenInitializesPoolWithLiquidity() public {
        (address token, address locker) =
            launcher.launchProtocolToken("filter.fun", "FILTER", "ipfs://filter");

        // Position exists and has nonzero liquidity. (Note: `manager.getLiquidity(pid)` returns
        // IN-RANGE liquidity; our seed is intentionally out-of-range so we must query the
        // position directly.)
        FilterLpLocker l = FilterLpLocker(locker);
        PoolKey memory key = l.poolKey();
        PoolId pid = key.toId();
        bytes32 positionId =
            keccak256(abi.encodePacked(address(l), l.tickLower(), l.tickUpper(), l.positionSalt()));
        uint128 positionLiquidity = manager.getPositionLiquidity(pid, positionId);
        assertGt(positionLiquidity, 0, "position should be seeded");

        // Token total supply is essentially all in the V4 PoolManager via the locker's position
        // (V4's liquidity math leaves single-digit dust in the locker — acceptable).
        assertEq(IERC20(token).totalSupply(), 1_000_000_000 ether);
        uint256 inManager = IERC20(token).balanceOf(address(manager));
        assertGt(inManager, 1_000_000_000 ether - 1e15, "almost all supply in pool");
    }

    function test_TraderCanBuyThroughPool() public {
        (address token,) = launcher.launchProtocolToken("filter.fun", "FILTER", "");
        PoolKey memory key = FilterLpLocker(launcher.lockerOf(1, token)).poolKey();

        // Trader gets USDC and approves the V4 swap router.
        usdc.mint(trader, 100e6);
        vm.prank(trader);
        usdc.approve(address(swapRouter), type(uint256).max);

        // Decide swap direction: input is USDC.
        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = !tokenIsZero; // USDC → token

        uint256 traderTokenBefore = IERC20(token).balanceOf(trader);

        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(50e6), // exactIn 50 USDC
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 traderTokenAfter = IERC20(token).balanceOf(trader);
        assertGt(traderTokenAfter, traderTokenBefore, "trader received tokens");
    }

    function test_LockerLiquidatesToUSDC() public {
        (address token,) = launcher.launchProtocolToken("filter.fun", "FILTER", "");
        FilterLpLocker locker = FilterLpLocker(launcher.lockerOf(1, token));

        // Drive some USDC into the LP via a trade so liquidation has something to recover.
        usdc.mint(trader, 1000e6);
        vm.prank(trader);
        usdc.approve(address(swapRouter), type(uint256).max);
        PoolKey memory key = locker.poolKey();
        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = !tokenIsZero;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(500e6),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // Now the pool holds ~500 USDC + remaining tokens. Liquidate.
        address vault = launcher.vaultOf(1);
        uint256 vaultUsdcBefore = usdc.balanceOf(vault);
        vm.prank(vault);
        uint256 out = locker.liquidateToUSDC(vault, 0);
        assertGt(out, 0, "recovered USDC");
        assertEq(usdc.balanceOf(vault), vaultUsdcBefore + out);
        assertEq(locker.liquidated(), true);
    }

    function test_LockerBuysTokenWithUSDC() public {
        (address token,) = launcher.launchProtocolToken("filter.fun", "FILTER", "");
        FilterLpLocker locker = FilterLpLocker(launcher.lockerOf(1, token));

        // Drive USDC into the pool first so there's something to buy from.
        usdc.mint(trader, 1000e6);
        vm.prank(trader);
        usdc.approve(address(swapRouter), type(uint256).max);
        PoolKey memory key = locker.poolKey();
        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = !tokenIsZero;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(800e6),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // Vault prepares to buy more tokens with USDC.
        address vault = launcher.vaultOf(1);
        usdc.mint(vault, 100e6);
        vm.prank(vault);
        usdc.approve(address(locker), 100e6);

        address recipient = makeAddr("buyRecipient");
        vm.prank(vault);
        uint256 tokensOut = locker.buyTokenWithUSDC(100e6, recipient, 0);
        assertGt(tokensOut, 0, "received tokens");
        assertEq(IERC20(token).balanceOf(recipient), tokensOut);
    }

    function test_HookRejectsExternalLiquidityAdds() public {
        (address token,) = launcher.launchProtocolToken("filter.fun", "FILTER", "");
        PoolKey memory key = FilterLpLocker(launcher.lockerOf(1, token)).poolKey();

        // External party tries to add liquidity directly via the modifyLiquidity router.
        vm.expectRevert();
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, "");
    }
}
