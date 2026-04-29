// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {POLManager, IPOLVaultRecord} from "../src/POLManager.sol";
import {POLVault} from "../src/POLVault.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockLauncherView} from "./mocks/MockLauncherView.sol";

/// @notice Stub locker that mimics the FilterLpLocker.addPolLiquidity contract: pulls WETH
///         from the manager and reports a synthetic (used, used, liq) tuple. We need a stand-in
///         here because the real locker is V4-tied; the V4 integration test exercises the
///         full path with a live PoolManager.
contract StubLocker {
    IERC20 public immutable weth;
    uint256 public mintRate; // tokens per WETH (18-decimal)
    uint128 public liquidityReturn;

    uint256 public lastWethIn;

    constructor(IERC20 weth_, uint256 mintRate_, uint128 liquidityReturn_) {
        weth = weth_;
        mintRate = mintRate_;
        liquidityReturn = liquidityReturn_;
    }

    function addPolLiquidity(uint256 wethIn)
        external
        returns (uint256 wethUsed, uint256 tokensUsed, uint128 liquidity)
    {
        weth.transferFrom(msg.sender, address(this), wethIn);
        lastWethIn = wethIn;
        // Mimic locker semantics: only the LP-leg comes back as wethUsed (≈ half).
        wethUsed = wethIn / 2;
        tokensUsed = (wethIn * mintRate) / 1e18;
        liquidity = liquidityReturn;
    }
}

/// @notice Auth + accounting tests for POLManager. The headline guarantee is that only the
///         launcher's registered SeasonVault for `seasonId` can deploy POL — otherwise an
///         attacker could flush pre-approved WETH from any season vault into a malicious
///         locker. Tests verify:
///         - vault auth gate (registered vs. arbitrary caller)
///         - locker resolution gate (unknown winner → revert)
///         - zero-amount rejection
///         - wethDeployed is the FULL `wethAmount` (not just the LP-leg `wethUsed`)
///         - POLVault gets exactly one `recordDeployment` call per `deployPOL`
contract POLManagerTest is Test {
    POLManager polManager;
    POLVault polVault;
    MockLauncherView launcher;
    MockWETH weth;
    StubLocker locker;

    address realVault = makeAddr("realVault");
    address attacker = makeAddr("attacker");
    address winner = makeAddr("winner");
    address otherWinner = makeAddr("otherWinner");

    uint256 constant SEASON = 1;
    uint256 constant MINT_RATE = 100_000e18; // 100_000 tokens per WETH
    uint128 constant LIQ_RETURN = 12_345;

    function setUp() public {
        weth = new MockWETH();
        launcher = new MockLauncherView();
        polVault = new POLVault(address(this));
        polManager = new POLManager(address(launcher), address(weth), IPOLVaultRecord(address(polVault)));
        polVault.setPolManager(address(polManager));

        locker = new StubLocker(weth, MINT_RATE, LIQ_RETURN);

        launcher.setVault(SEASON, realVault);
        launcher.setLocker(SEASON, winner, address(locker));
    }

    function _approveAndCall(address from, uint256 seasonId, address w, uint256 amount)
        internal
        returns (uint256 wethDeployed, uint256 tokensDeployed, uint128 liquidity)
    {
        weth.mint(from, amount);
        vm.prank(from);
        weth.approve(address(polManager), amount);
        vm.prank(from);
        return polManager.deployPOL(seasonId, w, amount);
    }

    // ============================================================ Auth

    function test_DeployPOL_RejectsArbitraryCaller() public {
        weth.mint(attacker, 1 ether);
        vm.prank(attacker);
        weth.approve(address(polManager), 1 ether);
        vm.prank(attacker);
        vm.expectRevert(POLManager.NotRegisteredVault.selector);
        polManager.deployPOL(SEASON, winner, 1 ether);
    }

    function test_DeployPOL_RejectsUnknownLocker() public {
        // `otherWinner` has no locker registered for this season.
        weth.mint(realVault, 1 ether);
        vm.prank(realVault);
        weth.approve(address(polManager), 1 ether);
        vm.prank(realVault);
        vm.expectRevert(POLManager.UnknownLocker.selector);
        polManager.deployPOL(SEASON, otherWinner, 1 ether);
    }

    function test_DeployPOL_RejectsZeroAmount() public {
        vm.prank(realVault);
        vm.expectRevert(POLManager.ZeroAmount.selector);
        polManager.deployPOL(SEASON, winner, 0);
    }

    // ============================================================ Happy path + accounting

    function test_DeployPOL_HappyPath() public {
        (uint256 wethDeployed, uint256 tokensDeployed, uint128 liquidity) =
            _approveAndCall(realVault, SEASON, winner, 1 ether);

        // wethDeployed = full input (NOT the LP-leg). This is the headline number for
        // POLVault accounting: how much protocol WETH committed to the position.
        assertEq(wethDeployed, 1 ether, "wethDeployed = full committed");
        assertEq(tokensDeployed, MINT_RATE, "tokensDeployed");
        assertEq(liquidity, LIQ_RETURN, "liquidity passthrough");

        // POLVault recorded exactly this deployment.
        assertEq(polVault.deploymentCount(), 1);
        POLVault.Deployment memory d = polVault.deploymentOf(SEASON);
        assertEq(d.winner, winner);
        assertEq(d.wethDeployed, 1 ether);
        assertEq(d.tokensDeployed, MINT_RATE);
        assertEq(d.liquidity, LIQ_RETURN);

        // The full input WETH ended up at the locker (POLManager retained nothing).
        assertEq(weth.balanceOf(address(locker)), 1 ether);
        assertEq(weth.balanceOf(address(polManager)), 0);
    }

    function test_DeployPOL_PerSeasonRecording() public {
        // Set up a second season + locker pair.
        address vault2 = makeAddr("vault2");
        address winner2 = makeAddr("winner2");
        StubLocker locker2 = new StubLocker(weth, MINT_RATE / 2, LIQ_RETURN * 2);
        launcher.setVault(2, vault2);
        launcher.setLocker(2, winner2, address(locker2));

        _approveAndCall(realVault, SEASON, winner, 1 ether);
        _approveAndCall(vault2, 2, winner2, 2 ether);

        assertEq(polVault.deploymentCount(), 2);
        assertEq(polVault.deploymentOf(SEASON).winner, winner);
        assertEq(polVault.deploymentOf(2).winner, winner2);
        assertEq(polVault.getTotalPOLValue(), 3 ether);
    }

    function test_DeployPOL_RejectsRedeployForSameSeason() public {
        _approveAndCall(realVault, SEASON, winner, 1 ether);
        // Second call hits POLVault.AlreadyRecorded.
        weth.mint(realVault, 1 ether);
        vm.prank(realVault);
        weth.approve(address(polManager), 1 ether);
        vm.prank(realVault);
        vm.expectRevert(POLVault.AlreadyRecorded.selector);
        polManager.deployPOL(SEASON, winner, 1 ether);
    }
}
