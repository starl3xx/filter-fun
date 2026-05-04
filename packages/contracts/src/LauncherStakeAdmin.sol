// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFilterLauncher} from "./interfaces/IFilterLauncher.sol";

/// @notice Subset of the launcher this admin reads from to authorise + resolve stakes.
interface IFilterLauncherForStakeAdmin {
    function oracle() external view returns (address);
    function phaseOf(uint256) external view returns (IFilterLauncher.Phase);
    function entryOf(uint256, address) external view returns (IFilterLauncher.TokenEntry memory);
    function forfeitRecipient() external view returns (address);
}

/// @title LauncherStakeAdmin
/// @notice Companion to `FilterLauncher` that owns post-deploy refundable-stake state for
///         every public token launch. Deployed inline by the launcher; the launcher forwards
///         per-token stake ETH here at deploy time, and the oracle calls
///         `applySoftFilter(...)` here directly to refund survivors / forfeit losers.
///
///         Lives outside the launcher to keep the launcher under EIP-170 (24,576 B runtime).
///         The deferred-activation refactor (Epic 1.15a) plus ticker-uniqueness state pushed
///         the launcher past the limit; pulling out the stake bookkeeping shaves ~1 KB of
///         dual-loop + struct-write bytecode without changing externally-visible semantics.
contract LauncherStakeAdmin is ReentrancyGuard {
    error NotLauncher();
    error NotOracle();
    error WrongPhase();
    error UnknownToken();
    error AlreadyResolved();
    error RefundFailed();

    event StakeRefunded(
        uint256 indexed seasonId, address indexed token, address indexed creator, uint256 amount
    );
    event StakeForfeited(
        uint256 indexed seasonId, address indexed token, address indexed creator, uint256 amount
    );

    /// @notice Launcher this admin is paired with. Authority for `recordLaunch` (called from
    ///         the launcher's deploy path); reads `oracle`, `forfeitRecipient`, `phaseOf`,
    ///         `entryOf` from this address for `applySoftFilter`.
    IFilterLauncherForStakeAdmin public immutable launcher;

    /// @notice Per-token launch info. Populated by the launcher at `_deployToken` time;
    ///         consumed (and updated) by `applySoftFilter`.
    mapping(uint256 => mapping(address => IFilterLauncher.LaunchInfo)) internal _launchInfo;

    constructor(IFilterLauncherForStakeAdmin launcher_) {
        launcher = launcher_;
    }

    function launchInfoOf(uint256 seasonId, address token)
        external
        view
        returns (IFilterLauncher.LaunchInfo memory)
    {
        return _launchInfo[seasonId][token];
    }

    /// @notice Launcher-only: write the launch slot's stake bookkeeping and accept the stake
    ///         ETH (when `stakeAmount > 0`). The launcher forwards the released-from-escrow
    ///         amount with the call.
    function recordLaunch(
        uint256 seasonId,
        address token,
        uint64 slotIndex,
        uint128 costPaid,
        uint128 stakeAmount
    ) external payable {
        if (msg.sender != address(launcher)) revert NotLauncher();
        _launchInfo[seasonId][token] = IFilterLauncher.LaunchInfo({
            slotIndex: slotIndex,
            costPaid: costPaid,
            stakeAmount: stakeAmount,
            refunded: false,
            filteredEarly: false
        });
    }

    /// @notice Resolve the refundable-stake outcome for a batch of launched tokens. Survivors
    ///         get their stake refunded to the original creator; forfeitures forward the stake
    ///         to the launcher's `forfeitRecipient`.
    function applySoftFilter(uint256 seasonId, address[] calldata survivors, address[] calldata forfeited)
        external
        nonReentrant
    {
        if (msg.sender != launcher.oracle()) revert NotOracle();
        IFilterLauncher.Phase p = launcher.phaseOf(seasonId);
        if (p == IFilterLauncher.Phase.Launch || p == IFilterLauncher.Phase(0)) revert WrongPhase();

        for (uint256 i = 0; i < survivors.length; ++i) {
            address t = survivors[i];
            IFilterLauncher.TokenEntry memory entry = launcher.entryOf(seasonId, t);
            if (entry.token == address(0) || entry.isProtocolLaunched) revert UnknownToken();
            IFilterLauncher.LaunchInfo storage info = _launchInfo[seasonId][t];
            if (info.refunded || info.filteredEarly) revert AlreadyResolved();
            uint256 amount = info.stakeAmount;
            info.refunded = true;
            info.stakeAmount = 0;
            if (amount > 0) {
                (bool ok,) = entry.creator.call{value: amount}("");
                if (!ok) revert RefundFailed();
            }
            emit StakeRefunded(seasonId, t, entry.creator, amount);
        }

        address recipient = launcher.forfeitRecipient();
        for (uint256 i = 0; i < forfeited.length; ++i) {
            address t = forfeited[i];
            IFilterLauncher.TokenEntry memory entry = launcher.entryOf(seasonId, t);
            if (entry.token == address(0) || entry.isProtocolLaunched) revert UnknownToken();
            IFilterLauncher.LaunchInfo storage info = _launchInfo[seasonId][t];
            if (info.refunded || info.filteredEarly) revert AlreadyResolved();
            uint256 amount = info.stakeAmount;
            info.filteredEarly = true;
            info.stakeAmount = 0;
            if (amount > 0) {
                (bool ok,) = recipient.call{value: amount}("");
                if (!ok) revert RefundFailed();
            }
            emit StakeForfeited(seasonId, t, entry.creator, amount);
        }
    }

    /// @notice Allow the launcher to refund excess to recipients post-resolve, and accept
    ///         stake ETH from `recordLaunch`. Without this, `recordLaunch` payable would fail
    ///         when the launcher forwards via `call`.
    receive() external payable {
        if (msg.sender != address(launcher)) revert NotLauncher();
    }
}
