// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ILpLocker
/// @notice External surface of `FilterLpLocker`. Used by `SeasonVault` to drive settlement.
interface ILpLocker {
    /// @notice Drains accumulated swap fees from the position and splits per BPS.
    function collectFees() external;

    /// @notice Removes 100% of the position's liquidity, swaps the launched-token leg to USDC,
    ///         and transfers the resulting USDC to `recipient`. Vault-only.
    function liquidateToUSDC(address recipient, uint256 minOutUSDC) external returns (uint256 usdcOut);

    /// @notice Caller (the SeasonVault) sends USDC; this swap converts it to the launched token,
    ///         delivered to `recipient`. Vault-only.
    function buyTokenWithUSDC(uint256 usdcIn, address recipient, uint256 minOutTokens)
        external
        returns (uint256 tokensOut);

    /// @notice The token whose pool this locker holds.
    function token() external view returns (address);

    /// @notice The base-asset (USDC) used in this locker's pool.
    function baseAsset() external view returns (address);

    /// @notice True if `liquidateToUSDC` has already executed for this locker.
    function liquidated() external view returns (bool);
}
