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
import {MiniMerkle} from "../utils/MiniMerkle.sol";

/// @notice Multi-loser counterpart to `V4Settlement`. A single-loser path passes through the
///         vault's loop trivially (one iteration, no inter-liquidation state to corrupt); this
///         test forces three sequential liquidations + a two-leaf Merkle tree so:
///         - the pot accumulates across calls, and
///         - claim proofs that are NOT empty actually round-trip through verifyCalldata.
contract V4MultiLoserSettlementTest is Test, Deployers {
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
    address aliceUser = makeAddr("alice");
    address bobUser = makeAddr("bob");

    function setUp() public {
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);

        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, polRecipient, IBonusFunding(address(bonus)), address(weth)
        );

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

    function _buyWithWETH(address token, uint256 wethIn) internal {
        PoolKey memory key = FilterLpLocker(launcher.lockerOf(1, token)).poolKey();
        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = !tokenIsZero;
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

    function test_FullV4Settlement_MultipleLosersAndHolders() public {
        // 1. Launch winner + 3 losers.
        (address winnerToken,) = launcher.launchProtocolToken("Winner", "WIN", "");
        (address loser1,) = launcher.launchProtocolToken("Loser1", "L1", "");
        (address loser2,) = launcher.launchProtocolToken("Loser2", "L2", "");
        (address loser3,) = launcher.launchProtocolToken("Loser3", "L3", "");

        // 2. Drive WETH into every pool — different sizes per loser to exercise pot accumulation.
        weth.mint(trader, 5 ether);
        vm.prank(trader);
        weth.approve(address(swapRouter), type(uint256).max);
        _buyWithWETH(winnerToken, 0.5 ether);
        _buyWithWETH(loser1, 0.3 ether);
        _buyWithWETH(loser2, 0.5 ether);
        _buyWithWETH(loser3, 0.2 ether);

        // 3. Build a two-leaf rollover tree. Alice gets share=3, Bob gets share=2; total=5.
        //    Leaves are (user, share) — same encoding as `SeasonVault.claimRollover`.
        bytes32 leafAlice = keccak256(abi.encodePacked(aliceUser, uint256(3)));
        bytes32 leafBob = keccak256(abi.encodePacked(bobUser, uint256(2)));
        bytes32[2] memory leaves = [leafAlice, leafBob];
        bytes32 root = MiniMerkle.rootOfTwo(leafAlice, leafBob);

        // 4. submitSettlement with all three losers.
        SeasonVault vault = SeasonVault(launcher.vaultOf(1));
        address[] memory losers = new address[](3);
        losers[0] = loser1;
        losers[1] = loser2;
        losers[2] = loser3;
        uint256[] memory minOuts = new uint256[](3); // all zero — exercise sequential liquidations only

        vm.prank(oracle);
        vault.submitSettlement(winnerToken, losers, minOuts, root, 5, block.timestamp + 1 days);

        // 5. Liquidate each loser. Pot should grow monotonically; each call is independent of
        //    the others so order shouldn't matter, but we exercise the natural ranking order.
        uint256 potAfter1;
        uint256 potAfter2;
        uint256 potAfter3;

        vault.liquidate(loser1, 0);
        potAfter1 = weth.balanceOf(address(vault));
        assertGt(potAfter1, 0, "pot grew after loser1");

        vault.liquidate(loser2, 0);
        potAfter2 = weth.balanceOf(address(vault));
        assertGt(potAfter2, potAfter1, "pot grew after loser2");

        vault.liquidate(loser3, 0);
        potAfter3 = weth.balanceOf(address(vault));
        assertGt(potAfter3, potAfter2, "pot grew after loser3");

        // 6. finalize.
        vault.finalize(0, 0);
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Distributing));
        uint256 totalRollover = vault.rolloverWinnerTokens();
        assertGt(totalRollover, 0, "rollover bought winner tokens");

        // 7. Both holders claim with non-empty proofs (one sibling each in a 2-leaf tree).
        bytes32[] memory proofAlice = MiniMerkle.proofForTwo(leaves, 0);
        bytes32[] memory proofBob = MiniMerkle.proofForTwo(leaves, 1);

        vm.prank(aliceUser);
        vault.claimRollover(3, proofAlice);
        uint256 aliceTokens = IERC20(winnerToken).balanceOf(aliceUser);

        vm.prank(bobUser);
        vault.claimRollover(2, proofBob);
        uint256 bobTokens = IERC20(winnerToken).balanceOf(bobUser);

        // 3:2 share split. Allow ±1 wei of integer-division dust.
        // Each holder receives `share * totalRollover / totalShares`.
        assertEq(aliceTokens, (3 * totalRollover) / 5, "alice got 3/5");
        assertEq(bobTokens, (2 * totalRollover) / 5, "bob got 2/5");

        // Sum claimed never exceeds what was bought; integer-rounding dust stays in vault.
        assertLe(aliceTokens + bobTokens, totalRollover, "no overspend");
    }

    /// @dev Liquidating the same loser twice must revert — keepers race for the bounty.
    /// Two losers (not one) so the phase stays at `Liquidating` between calls, otherwise
    /// the second liquidate would fall through to the WrongPhase guard instead of exercising
    /// the actual idempotency check.
    function test_DoubleLiquidationReverts() public {
        (address winnerToken,) = launcher.launchProtocolToken("Winner", "WIN", "");
        (address loser1,) = launcher.launchProtocolToken("Loser1", "L1", "");
        (address loser2,) = launcher.launchProtocolToken("Loser2", "L2", "");

        weth.mint(trader, 2 ether);
        vm.prank(trader);
        weth.approve(address(swapRouter), type(uint256).max);
        _buyWithWETH(winnerToken, 0.3 ether);
        _buyWithWETH(loser1, 0.3 ether);
        _buyWithWETH(loser2, 0.3 ether);

        bytes32 leaf = keccak256(abi.encodePacked(aliceUser, uint256(1)));

        SeasonVault vault = SeasonVault(launcher.vaultOf(1));
        address[] memory losers = new address[](2);
        losers[0] = loser1;
        losers[1] = loser2;
        uint256[] memory minOuts = new uint256[](2);

        vm.prank(oracle);
        vault.submitSettlement(winnerToken, losers, minOuts, leaf, 1, block.timestamp + 1 days);

        vault.liquidate(loser1, 0);

        // Second call on loser1 must revert via the AlreadyLiquidated guard. Phase stays at
        // Liquidating because loser2 hasn't been touched yet, so the WrongPhase path can't
        // mask the real check. Selector is contract-internal so we assert the failure
        // generically rather than hard-code it.
        vm.expectRevert();
        vault.liquidate(loser1, 0);
    }
}
