// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILpLocker} from "../../src/interfaces/ILpLocker.sol";
import {MockUSDC} from "./MockUSDC.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Test double for `FilterLpLocker`. Pretends each token has a fixed `usdcPerToken`
///         price; liquidate returns a configured base amount, buy mints winner tokens at the
///         same rate. Mirrors only the behavior `SeasonVault` actually depends on.
contract MockLpLocker is ILpLocker {
    using SafeERC20 for IERC20;

    address public immutable override token;
    address public immutable override baseAsset;
    address public vault;
    bool public override liquidated;

    /// @dev How much USDC `liquidateToUSDC` produces. Set per-test.
    uint256 public liquidationProceeds;

    /// @dev How many tokens minted per 1 USDC (in 18-dec token units per 1e6 USDC unit).
    uint256 public mintRate;

    constructor(address token_, address usdc_, address vault_) {
        token = token_;
        baseAsset = usdc_;
        vault = vault_;
    }

    function setLiquidationProceeds(uint256 amt) external {
        liquidationProceeds = amt;
    }

    function setMintRate(uint256 rate) external {
        mintRate = rate;
    }

    function fundProceedsTo(address from, uint256 amount) external {
        MockUSDC(baseAsset).mint(address(this), amount);
        from; // silence
    }

    function collectFees() external override {}

    function liquidateToUSDC(address recipient, uint256 minOut) external override returns (uint256 out) {
        require(msg.sender == vault, "not vault");
        require(!liquidated, "liq");
        liquidated = true;
        out = liquidationProceeds;
        require(out >= minOut, "minOut");
        // Mint to ourselves then transfer; this mock holds no pre-funding constraints.
        MockUSDC(baseAsset).mint(address(this), out);
        IERC20(baseAsset).safeTransfer(recipient, out);
    }

    function buyTokenWithUSDC(uint256 usdcIn, address recipient, uint256 minOut)
        external
        override
        returns (uint256 tokensOut)
    {
        require(msg.sender == vault, "not vault");
        IERC20(baseAsset).safeTransferFrom(msg.sender, address(this), usdcIn);
        tokensOut = (usdcIn * mintRate) / 1e6; // mintRate is tokens-per-USDC scaled by 1e6
        require(tokensOut >= minOut, "minOut");
        IMintable(token).mint(recipient, tokensOut);
    }
}
