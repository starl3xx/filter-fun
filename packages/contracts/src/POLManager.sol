// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILpLocker} from "./interfaces/ILpLocker.sol";

interface IPOLVaultRecord {
    function recordDeployment(
        uint256 seasonId,
        address winner,
        uint256 wethDeployed,
        uint256 tokensDeployed,
        uint128 liquidity
    ) external;
}

interface ILauncherViewPM {
    function vaultOf(uint256 seasonId) external view returns (address);
    function lockerOf(uint256 seasonId, address token) external view returns (address);
}

interface ILpLockerPolAdd {
    function addPolLiquidity(uint256 wethIn)
        external
        returns (uint256 wethUsed, uint256 tokensUsed, uint128 liquidity);
}

/// @title POLManager
/// @notice Stateless orchestrator that turns the per-season POL WETH reserve into a permanent
///         V4 LP position on the winner pool. Called once by the SeasonVault at `submitWinner`.
///
///         Flow:
///           1. SeasonVault transfers `wethAmount` WETH to this contract.
///           2. This contract approves the winner's `FilterLpLocker` for the same amount.
///           3. The locker is invoked via `addPolLiquidity` — it swaps half the WETH for the
///              winner token, adds a permanent LP position keyed by `POL_SALT`, and returns
///              the actually-used (weth, tokens, liquidity) tuple.
///           4. We record the deployment on the singleton `POLVault` so the indexer + UI can
///              surface per-token / per-season exposure.
///
///         Auth: only the SeasonVault registered for `seasonId` on the launcher may invoke.
///         Anyone else calling would just transfer their own WETH into a locker — but we still
///         gate to keep the recorded inflow truthful (the POLVault accounting is the canonical
///         source for the broadcast UI).
contract POLManager {
    using SafeERC20 for IERC20;

    error NotRegisteredVault();
    error ZeroAmount();
    error UnknownLocker();

    address public immutable launcher;
    address public immutable weth;
    IPOLVaultRecord public immutable polVault;

    event PolDeployed(
        uint256 indexed seasonId,
        address indexed winner,
        address indexed locker,
        uint256 wethUsed,
        uint256 tokensUsed,
        uint128 liquidity
    );

    constructor(address launcher_, address weth_, IPOLVaultRecord polVault_) {
        launcher = launcher_;
        weth = weth_;
        polVault = polVault_;
    }

    /// @notice Deploy a season's POL WETH reserve into a permanent LP position on the winner.
    ///         Caller must be the launcher's registered SeasonVault for `seasonId`. The caller
    ///         must have approved this contract for `wethAmount` of WETH before invoking — this
    ///         function pulls it, forwards to the locker, and records the deployment.
    ///
    ///         The locker's `addPolLiquidity` swaps half the WETH to winner tokens and adds
    ///         a permanent LP position with both legs. Total WETH committed = `wethAmount`
    ///         (the locker's `wethUsed` return tracks the LP-leg specifically — half of
    ///         `wethAmount`). For POLVault accounting we use the full committed amount since
    ///         that's the protocol's actual outflow into the position.
    function deployPOL(uint256 seasonId, address winner, uint256 wethAmount)
        external
        returns (uint256 wethDeployed, uint256 tokensDeployed, uint128 liquidity)
    {
        if (msg.sender != ILauncherViewPM(launcher).vaultOf(seasonId)) revert NotRegisteredVault();
        if (wethAmount == 0) revert ZeroAmount();

        address locker = ILauncherViewPM(launcher).lockerOf(seasonId, winner);
        if (locker == address(0)) revert UnknownLocker();

        // Pull WETH in from the caller (vault approved us for `wethAmount`), then forward-approve
        // the locker. The locker pulls via safeTransferFrom inside `addPolLiquidity`.
        IERC20(weth).safeTransferFrom(msg.sender, address(this), wethAmount);
        IERC20(weth).forceApprove(locker, wethAmount);

        (, tokensDeployed, liquidity) = ILpLockerPolAdd(locker).addPolLiquidity(wethAmount);
        wethDeployed = wethAmount;

        polVault.recordDeployment(seasonId, winner, wethDeployed, tokensDeployed, liquidity);

        emit PolDeployed(seasonId, winner, locker, wethDeployed, tokensDeployed, liquidity);
    }
}
