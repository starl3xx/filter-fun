// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test stand-in for the real POLManager. Pulls the caller's WETH (so the SeasonVault's
///         approve+transferFrom path is exercised) and records what was deployed for assertions.
///         Optionally mints synthetic "winner tokens" at a fixed rate so the test can observe a
///         deterministic `tokensDeployed` figure without going through a real V4 swap.
contract MockPOLManager {
    using SafeERC20 for IERC20;

    IERC20 public immutable weth;

    /// @dev Tokens-per-WETH (18-decimal). Zero by default → mock returns zero tokens.
    uint256 public mintRate;
    /// @dev Static liquidity figure returned per call (doesn't reflect any real position).
    uint128 public liquidityReturn;

    uint256 public callCount;
    address public lastSender;
    uint256 public lastSeasonId;
    address public lastWinner;
    uint256 public lastWethAmount;
    uint256 public lastTokens;
    uint128 public lastLiquidity;

    constructor(IERC20 weth_) {
        weth = weth_;
    }

    function setMintRate(uint256 rate) external {
        mintRate = rate;
    }

    function setLiquidityReturn(uint128 liq) external {
        liquidityReturn = liq;
    }

    function deployPOL(uint256 seasonId, address winner, uint256 wethAmount)
        external
        returns (uint256 wethDeployed, uint256 tokensDeployed, uint128 liquidity)
    {
        weth.safeTransferFrom(msg.sender, address(this), wethAmount);

        ++callCount;
        lastSender = msg.sender;
        lastSeasonId = seasonId;
        lastWinner = winner;
        lastWethAmount = wethAmount;

        wethDeployed = wethAmount;
        tokensDeployed = (wethAmount * mintRate) / 1e18;
        liquidity = liquidityReturn;

        lastTokens = tokensDeployed;
        lastLiquidity = liquidity;
    }
}
