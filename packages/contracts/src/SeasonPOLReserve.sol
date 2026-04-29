// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SeasonPOLReserve
/// @notice Per-season WETH holder for protocol-owned-liquidity. The 10% POL slice from each
///         filter event accumulates here and is *not* deployed until the final winner is known —
///         this keeps the protocol from biasing the live competition by buying mid-week into
///         tokens that may yet be filtered.
///
///         Authority: only the season's `SeasonVault` can credit deposits or withdraw at
///         finalization. The reserve never trades — the vault drains it and runs the deployment.
contract SeasonPOLReserve {
    using SafeERC20 for IERC20;

    address public immutable vault;
    address public immutable weth;
    uint256 public immutable seasonId;

    /// @notice Running sum of POL deposits across all filter events. Strictly monotonic — does
    ///         not drop when the vault drains the WETH at finalization (see `getTotalPOL` for
    ///         the live balance).
    uint256 public totalAccumulated;

    /// @notice True after the vault has drained the reserve. Re-entry into `withdrawAll` is
    ///         forbidden so finalization is one-shot.
    bool public deployed;

    event PolAccumulated(uint256 amount, uint256 totalAccumulated);
    event PolWithdrawn(address indexed to, uint256 amount);

    error NotVault();
    error AlreadyDeployed();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(address vault_, address weth_, uint256 seasonId_) {
        vault = vault_;
        weth = weth_;
        seasonId = seasonId_;
    }

    /// @notice Live WETH balance held by this reserve.
    function getTotalPOL() external view returns (uint256) {
        return IERC20(weth).balanceOf(address(this));
    }

    /// @notice Vault calls this *after* it has already `safeTransfer`'d the WETH in. We use
    ///         transfer-then-notify rather than pull-style transferFrom to avoid the extra
    ///         allowance round-trip — the vault is the only authorized depositor anyway.
    function notifyDeposit(uint256 amount) external onlyVault {
        totalAccumulated += amount;
        emit PolAccumulated(amount, totalAccumulated);
    }

    /// @notice Vault drains the entire WETH balance at final settlement and runs the deployment
    ///         itself (buys winner tokens, sends to POLVault). One-shot — guarded by `deployed`.
    function withdrawAll() external onlyVault returns (uint256 amount) {
        if (deployed) revert AlreadyDeployed();
        deployed = true;
        amount = IERC20(weth).balanceOf(address(this));
        if (amount > 0) IERC20(weth).safeTransfer(vault, amount);
        emit PolWithdrawn(vault, amount);
    }
}
