// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILpLocker} from "../../src/interfaces/ILpLocker.sol";
import {MockWETH} from "./MockWETH.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Test double for `FilterLpLocker`. Liquidate returns a configured WETH amount; buy
///         mints winner tokens at a fixed `mintRate` (winner-tokens per WETH, both 18 decimals).
///         Mirrors only the behavior `SeasonVault` actually depends on.
contract MockLpLocker is ILpLocker {
    using SafeERC20 for IERC20;

    address public immutable override token;
    address public immutable override baseAsset;
    address public vault;
    bool public override liquidated;
    /// @notice Mirrors the FilterLpLocker post-settlement marker (Epic 1.16). SeasonVault
    ///         calls `markWinnerSettled` on the winner's locker at `submitWinner` time; the
    ///         mock just records the timestamp so tests can assert the call landed.
    uint256 public winnerSettledAt;

    /// @dev How much WETH `liquidateToWETH` produces. Set per-test.
    uint256 public liquidationProceeds;

    /// @dev How many tokens minted per 1 WETH (both in 1e18 raw units).
    uint256 public mintRate;

    constructor(address token_, address weth_, address vault_) {
        token = token_;
        baseAsset = weth_;
        vault = vault_;
    }

    function setLiquidationProceeds(uint256 amt) external {
        liquidationProceeds = amt;
    }

    function setMintRate(uint256 rate) external {
        mintRate = rate;
    }

    function fundProceedsTo(address from, uint256 amount) external {
        MockWETH(baseAsset).mint(address(this), amount);
        from; // silence
    }

    function collectFees() external override {}

    /// @notice Mirrors `FilterLpLocker.markWinnerSettled` — vault-only, idempotent-revert.
    function markWinnerSettled() external {
        require(msg.sender == vault, "not vault");
        require(winnerSettledAt == 0, "already settled");
        winnerSettledAt = block.timestamp;
    }

    function liquidateToWETH(address recipient, uint256 minOut) external override returns (uint256 out) {
        require(msg.sender == vault, "not vault");
        require(!liquidated, "liq");
        liquidated = true;
        out = liquidationProceeds;
        require(out >= minOut, "minOut");
        MockWETH(baseAsset).mint(address(this), out);
        IERC20(baseAsset).safeTransfer(recipient, out);
    }

    function buyTokenWithWETH(uint256 wethIn, address recipient, uint256 minOut)
        external
        override
        returns (uint256 tokensOut)
    {
        require(msg.sender == vault, "not vault");
        IERC20(baseAsset).safeTransferFrom(msg.sender, address(this), wethIn);
        tokensOut = (wethIn * mintRate) / 1e18; // mintRate scaled by 1e18 (winner-tokens per WETH)
        require(tokensOut >= minOut, "minOut");
        IMintable(token).mint(recipient, tokensOut);
    }
}
