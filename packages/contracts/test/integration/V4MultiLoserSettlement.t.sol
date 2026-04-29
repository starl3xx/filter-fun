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
import {SeasonVault, IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {POLVault} from "../../src/POLVault.sol";
import {POLManager, IPOLVaultRecord} from "../../src/POLManager.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";

import {MockWETH} from "../mocks/MockWETH.sol";
import {HookMiner} from "../../src/libraries/HookMiner.sol";
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
    POLVault polVault;
    POLManager polManager;
    MockWETH weth;

    address owner = address(this);
    address oracle = makeAddr("oracle");
    address treasury = makeAddr("treasury");
    address mechanics = makeAddr("mechanics");
    address polVaultOwner = makeAddr("polVaultOwner");

    address trader = makeAddr("trader");
    address aliceUser = makeAddr("alice");
    address bobUser = makeAddr("bob");

    function setUp() public {
        deployFreshManagerAndRouters();

        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        polVault = new POLVault(address(this));

        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
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
            address(polManager)
        );
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

        // 4. Three filter events, one loser each — exercises POL accumulation across multiple
        //    cuts before the final winner is known. POL must NOT be deployed mid-week.
        SeasonVault vault = SeasonVault(launcher.vaultOf(1));

        uint256 polReserveAfter1;
        uint256 polReserveAfter2;
        uint256 polReserveAfter3;

        address[] memory cut1 = new address[](1);
        cut1[0] = loser1;
        uint256[] memory _minOuts1 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(cut1, _minOuts1);
        polReserveAfter1 = vault.polReserveBalance();
        assertGt(polReserveAfter1, 0, "POL acc after cut1");

        address[] memory cut2 = new address[](1);
        cut2[0] = loser2;
        uint256[] memory _minOuts2 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(cut2, _minOuts2);
        polReserveAfter2 = vault.polReserveBalance();
        assertGt(polReserveAfter2, polReserveAfter1, "POL grew after cut2");

        address[] memory cut3 = new address[](1);
        cut3[0] = loser3;
        uint256[] memory _minOuts3 = new uint256[](1);
        vm.prank(oracle);
        vault.processFilterEvent(cut3, _minOuts3);
        polReserveAfter3 = vault.polReserveBalance();
        assertGt(polReserveAfter3, polReserveAfter2, "POL grew after cut3");

        // POL is held as WETH — no LP add has happened yet.
        assertEq(polVault.deploymentCount(), 0, "POL not deployed mid-week");

        // 5. Final settlement: oracle commits the winner. Drains rollover/bonus/POL reserves
        //    and converts to winner tokens via the WINNER's locker.
        vm.prank(oracle);
        vault.submitWinner(winnerToken, root, 5, 0, 0);
        assertEq(uint8(vault.phase()), uint8(SeasonVault.Phase.Distributing));
        uint256 totalRollover = vault.rolloverWinnerTokens();
        assertGt(totalRollover, 0, "rollover bought winner tokens");

        // POL deployed: WETH reserve emptied, deployment recorded on POLVault. Actual LP lives
        // inside the winner's FilterLpLocker keyed by POL_SALT.
        assertEq(vault.polReserveBalance(), 0, "POL reserve drained");
        assertEq(polVault.deploymentCount(), 1, "POL recorded");
        POLVault.Deployment memory dep = polVault.deploymentOf(1);
        assertEq(dep.winner, winnerToken);
        assertEq(dep.wethDeployed, vault.polDeployedWeth());
        assertEq(dep.tokensDeployed, vault.polDeployedTokens());
        assertGt(dep.liquidity, 0, "real V4 liquidity minted");
        FilterLpLocker winnerLocker_ = FilterLpLocker(launcher.lockerOf(1, winnerToken));
        assertEq(winnerLocker_.polLiquidity(), dep.liquidity, "locker holds POL position");

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

    /// @dev Filtering the same token twice must revert — the same loser can't pay a second
    ///      losers-pot dividend.
    function test_DoubleFilterEventReverts() public {
        (address winnerToken,) = launcher.launchProtocolToken("Winner", "WIN", "");
        (address loser1,) = launcher.launchProtocolToken("Loser1", "L1", "");

        weth.mint(trader, 1 ether);
        vm.prank(trader);
        weth.approve(address(swapRouter), type(uint256).max);
        _buyWithWETH(winnerToken, 0.3 ether);
        _buyWithWETH(loser1, 0.3 ether);

        SeasonVault vault = SeasonVault(launcher.vaultOf(1));
        address[] memory losers = new address[](1);
        losers[0] = loser1;
        uint256[] memory minOuts = new uint256[](1);

        vm.prank(oracle);
        vault.processFilterEvent(losers, minOuts);

        // Second filter event re-listing the same token must revert via AlreadyLiquidated.
        vm.prank(oracle);
        vm.expectRevert(SeasonVault.AlreadyLiquidated.selector);
        vault.processFilterEvent(losers, minOuts);
    }
}
