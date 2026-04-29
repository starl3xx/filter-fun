// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title POLVault
/// @notice Singleton sink for protocol-owned-liquidity exposure across all seasons. After each
///         season is finalized, the SeasonVault uses the accumulated POL reserve to buy winner
///         tokens and deposits them here. Per-season balances are tracked so the multisig can
///         reason about exposure per cohort.
///
///         The current iteration is a passive winner-token accumulator. A subsequent iteration
///         will extend this contract (or a related one) to actually pair with WETH and add LP
///         to the AMM; for now the protocol holds the bag, which is functionally equivalent for
///         alignment purposes (protocol gains/loses with the winner).
contract POLVault is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Per-season cumulative deposit count (winner tokens received from SeasonVault).
    mapping(uint256 => uint256) public seasonDeposit;
    /// @notice Per-season winning token recorded at deposit time.
    mapping(uint256 => address) public seasonWinner;

    /// @notice Cumulative inflow per (season, token) pair so an indexer can render history.
    event Deposited(uint256 indexed seasonId, address indexed winnerToken, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error AlreadyDeposited();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice SeasonVault deposits the winner tokens it bought with the POL reserve. Tokens are
    ///         pulled from the caller (no pre-approval workflow needed since the vault has
    ///         already transferred WETH out and is depositing the freshly-acquired tokens).
    function deposit(uint256 seasonId, address winnerToken, uint256 amount) external {
        if (seasonDeposit[seasonId] != 0) revert AlreadyDeposited();
        seasonDeposit[seasonId] = amount;
        seasonWinner[seasonId] = winnerToken;
        if (amount > 0) IERC20(winnerToken).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(seasonId, winnerToken, amount);
    }

    /// @notice Multisig escape hatch. Used to migrate POL into LP positions in a follow-up
    ///         iteration, or to handle emergencies (e.g. winner token getting paused).
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function balanceOf(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
