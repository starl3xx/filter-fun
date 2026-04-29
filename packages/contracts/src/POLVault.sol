// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface ILauncherView {
    function vaultOf(uint256 seasonId) external view returns (address);
}

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
///
///         Auth model: only the launcher's registered SeasonVault for a given seasonId may
///         deposit. We can't accept deposits from arbitrary callers — an attacker could
///         pre-deposit a worthless token for the next season, latch the one-deposit-per-season
///         flag, and DoS the legitimate `submitWinner` settlement call. Verified at deposit
///         time via the launcher's `vaultOf(seasonId)` view.
///
///         Deployment ordering: POLVault is deployed BEFORE FilterLauncher (since the launcher
///         takes the POLVault address in its constructor), so `launcher` is wired post-construction
///         via a one-shot `setLauncher`. After that call the address is permanent.
contract POLVault is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Filter-launcher singleton. Used to identify the legitimate SeasonVault for a
    ///         given seasonId. Set once via `setLauncher`; cannot be rotated afterward.
    address public launcher;

    /// @notice Per-season winner-token deposit amount. Zero for seasons where finalization
    ///         landed with `polDeployedTokens == 0` — see `deposited` for the actual flag.
    mapping(uint256 => uint256) public seasonDeposit;
    /// @notice Per-season winning token recorded at deposit time.
    mapping(uint256 => address) public seasonWinner;
    /// @notice One-shot flag: true once the SeasonVault has deposited, regardless of amount.
    ///         Tracking this separately from `seasonDeposit` is critical — a zero-amount
    ///         deposit (possible under extreme AMM conditions) would otherwise leave the
    ///         numeric guard transparent and admit a second, real deposit.
    mapping(uint256 => bool) public deposited;

    event LauncherSet(address indexed launcher);
    /// @notice Cumulative inflow per (season, token) pair so an indexer can render history.
    event Deposited(uint256 indexed seasonId, address indexed winnerToken, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error AlreadyDeposited();
    error LauncherAlreadySet();
    error LauncherNotSet();
    error NotRegisteredVault();
    error ZeroAddress();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice One-shot wire of the launcher. Owner-only; reverts if already set or zero.
    function setLauncher(address launcher_) external onlyOwner {
        if (launcher != address(0)) revert LauncherAlreadySet();
        if (launcher_ == address(0)) revert ZeroAddress();
        launcher = launcher_;
        emit LauncherSet(launcher_);
    }

    /// @notice SeasonVault deposits the winner tokens it bought with the POL reserve. Tokens
    ///         are pulled from the caller — the SeasonVault has already approved this contract
    ///         for `amount` before calling.
    ///
    ///         Authorization: the caller must be the launcher's registered SeasonVault for
    ///         `seasonId`. This both rejects arbitrary front-running (no anonymous DoS) and
    ///         confirms the deposit corresponds to a real, completed settlement.
    function deposit(uint256 seasonId, address winnerToken, uint256 amount) external {
        if (deposited[seasonId]) revert AlreadyDeposited();
        address l = launcher;
        if (l == address(0)) revert LauncherNotSet();
        if (msg.sender != ILauncherView(l).vaultOf(seasonId)) revert NotRegisteredVault();
        deposited[seasonId] = true;
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
