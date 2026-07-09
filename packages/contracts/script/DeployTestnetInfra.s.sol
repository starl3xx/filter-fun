// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// @notice Rehearsal-only infrastructure for Robinhood Chain testnet (46630), which has
///         NO canonical Uniswap v4 or WETH9 (preflight 2026-07-09 — only unvetted
///         third-party deploys). Deploys our own PoolManager + WETH9 + the v4-core test
///         routers so the testnet rehearsal exercises the exact same v4 surface the
///         Foundry integration suites use (`Deployers.deployFreshManagerAndRouters`).
///
///         MAINNET NEVER RUNS THIS — 4663 uses the canonical PoolManager
///         (0x8366a39cc670b4001a1121b8f6a443a643e40951) and WETH9
///         (0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73); the chainid gate below is a
///         hard stop, not a convention.
///
///         Usage (once per testnet bring-up):
///           forge script script/DeployTestnetInfra.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast
///         then paste the printed addresses into `.env.robinhood-testnet`
///         (V4_POOL_MANAGER_ADDRESS / WETH_ADDRESS) before running deploy-testnet.sh.
///         Swap/liquidity router addresses feed the rehearsal's trading harness.
contract DeployTestnetInfra is Script {
    function run() external {
        require(
            block.chainid == 46_630,
            "DeployTestnetInfra: rehearsal-only script; chainId != 46630 (Robinhood testnet)"
        );

        uint256 pk;
        try vm.envUint("DEPLOYER_PRIVATE_KEY") returns (uint256 v) {
            pk = v;
        } catch {
            pk = vm.envUint("PRIVATE_KEY");
        }
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        // PoolManager owner = deployer: on this rehearsal deployment nobody sets protocol
        // fees, but parking ownership on the deployer (vs address(0)) keeps the escape
        // hatch if a rehearsal scenario ever needs it.
        PoolManager poolManager = new PoolManager(deployer);
        WETH9 weth = new WETH9();
        PoolSwapTest swapRouter = new PoolSwapTest(IPoolManager(address(poolManager)));
        PoolModifyLiquidityTest liquidityRouter =
            new PoolModifyLiquidityTest(IPoolManager(address(poolManager)));

        vm.stopBroadcast();

        console2.log("=== Robinhood testnet rehearsal infra ===");
        console2.log("V4_POOL_MANAGER_ADDRESS=", address(poolManager));
        console2.log("WETH_ADDRESS=", address(weth));
        console2.log("swap router (trading harness):     ", address(swapRouter));
        console2.log("liquidity router (trading harness):", address(liquidityRouter));
        console2.log("Paste the first two into .env.robinhood-testnet, then run deploy-testnet.sh.");
    }
}

/// @notice Minimal WETH9 (0.8.x port of the canonical contract). The filter.fun suite
///         only ever moves WETH as a plain ERC-20 (no contract calls deposit/withdraw);
///         `deposit` exists so rehearsal traders can wrap faucet ETH to trade with.
contract WETH9 {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "WETH9: insufficient balance");
        balanceOf[msg.sender] -= wad;
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "WETH9: eth transfer failed");
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "WETH9: insufficient balance");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "WETH9: insufficient allowance");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
