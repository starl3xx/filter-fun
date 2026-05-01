// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {CreatorRegistry} from "./CreatorRegistry.sol";

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
    function vaultOf(uint256 seasonId) external view returns (address);
}

/// @title CreatorFeeDistributor
/// @notice Singleton sink for the 0.20% creator slice of every swap. Accrues per-token,
///         claimable by the registered creator. Eligibility is time-and-state gated:
///
///         - First 72 hours after launch (Days 1–3, recorded by `CreatorRegistry`). This
///           window is intentionally distinct from the Day 4 hard cut at hour 96: creator
///           fees flow during the warm-up days only, not into the cut window itself.
///         - Token has not yet been filtered (vault calls `markFiltered` at filter time).
///
///         When a fee arrives outside the eligibility window, it is redirected to the
///         treasury rather than credited — preserves the protocol BPS invariants without
///         leaking value to creators of already-filtered tokens.
///
///         Auth model:
///         - `notifyFee` is callable only by the active `FilterLpLocker` for that token
///           (verified via `launcher.lockerOf`).
///         - `markFiltered` is callable only by the active `SeasonVault` for that token's
///           season (verified via `launcher.vaultOf`).
///         - `claim` is callable only by the registered creator.
contract CreatorFeeDistributor {
    using SafeERC20 for IERC20;

    address public immutable launcher;
    address public immutable weth;
    address public immutable treasury;
    CreatorRegistry public immutable registry;
    uint256 public constant ELIGIBILITY_WINDOW = 72 hours;

    /// @notice Tracks per-token accrual state. `seasonId` lets `notifyFee` and
    ///         `markFiltered` verify their callers without re-reading the launcher each time.
    struct TokenInfo {
        uint256 seasonId;
        bool filtered;
        uint256 accrued; // total credited (across history, never decreases)
        uint256 claimed; // total withdrawn
    }

    mapping(address => TokenInfo) internal _info;
    mapping(address => bool) public registered;

    /// @notice Tracks last-seen WETH balance so `notifyFee` can verify the locker actually
    ///         transferred the WETH in this tx (vs. faking a bookkeeping call).
    uint256 public lastSeenBalance;

    event TokenRegistered(address indexed token, uint256 indexed seasonId);
    event CreatorFeeAccrued(address indexed token, address indexed creator, uint256 amount);
    event CreatorFeeRedirected(address indexed token, uint256 amount);
    event CreatorFeeClaimed(address indexed token, address indexed recipient, uint256 amount);
    event CreatorFeeDisabled(address indexed token);

    error NotLauncher();
    error NotRegisteredLocker();
    error NotRegisteredVault();
    error NotCreator();
    error AlreadyRegistered();
    error UnknownToken();
    error UnverifiedTransfer();

    modifier onlyLauncher() {
        if (msg.sender != launcher) revert NotLauncher();
        _;
    }

    constructor(address launcher_, address weth_, address treasury_, CreatorRegistry registry_) {
        launcher = launcher_;
        weth = weth_;
        treasury = treasury_;
        registry = registry_;
    }

    function infoOf(address token) external view returns (TokenInfo memory) {
        return _info[token];
    }

    function eligible(address token) public view returns (bool) {
        if (!registered[token]) return false;
        if (_info[token].filtered) return false;
        uint256 ts = registry.launchedAt(token);
        if (ts == 0) return false;
        if (block.timestamp > ts + ELIGIBILITY_WINDOW) return false;
        return true;
    }

    function pendingClaim(address token) external view returns (uint256) {
        TokenInfo storage i = _info[token];
        return i.accrued - i.claimed;
    }

    /// @notice Launcher records the (token, seasonId) at launch time. The creator and
    ///         launchedAt are read from the registry; we just stash the seasonId so the
    ///         per-token auth checks below can verify their callers.
    function registerToken(address token, uint256 seasonId) external onlyLauncher {
        if (registered[token]) revert AlreadyRegistered();
        registered[token] = true;
        _info[token].seasonId = seasonId;
        emit TokenRegistered(token, seasonId);
    }

    /// @notice Locker calls after `poolManager.take`-ing the WETH directly into this
    ///         contract. We verify the balance grew by the claimed amount, then either
    ///         credit the creator or redirect to treasury based on eligibility.
    ///
    ///         The caller-is-locker check prevents arbitrary callers from crediting
    ///         creators for WETH the protocol owns elsewhere.
    function notifyFee(address token, uint256 amount) external {
        TokenInfo storage info = _info[token];
        if (!registered[token]) revert UnknownToken();
        address expectedLocker = ILauncherView(launcher).lockerOf(info.seasonId, token);
        if (msg.sender != expectedLocker) revert NotRegisteredLocker();

        uint256 currentBalance = IERC20(weth).balanceOf(address(this));
        if (currentBalance < lastSeenBalance + amount) revert UnverifiedTransfer();
        lastSeenBalance = currentBalance;

        if (eligible(token)) {
            address creator = registry.creatorOf(token);
            info.accrued += amount;
            emit CreatorFeeAccrued(token, creator, amount);
        } else {
            // Past the 72h window or already filtered — redirect to treasury so the BPS
            // invariants stay honest (the protocol still collects the slice; the creator
            // just doesn't, because they no longer pass the alignment check).
            lastSeenBalance -= amount;
            IERC20(weth).safeTransfer(treasury, amount);
            emit CreatorFeeRedirected(token, amount);
        }
    }

    /// @notice Vault calls when a token is filtered, freezing creator-fee accrual for it.
    ///         Idempotent — repeated calls are no-ops.
    function markFiltered(address token) external {
        TokenInfo storage info = _info[token];
        if (!registered[token]) revert UnknownToken();
        address expectedVault = ILauncherView(launcher).vaultOf(info.seasonId);
        if (msg.sender != expectedVault) revert NotRegisteredVault();
        if (!info.filtered) {
            info.filtered = true;
            emit CreatorFeeDisabled(token);
        }
    }

    /// @notice Creator pulls accrued WETH for a token they own. `accrued - claimed` is the
    ///         pending balance; transferring it bumps `claimed` to match so the next call
    ///         only pays out new accruals.
    ///
    ///         Caller must be the registered creator; payout flows to the configured recipient
    ///         (defaults to the creator). This is the integration point for the Epic 1.12
    ///         `setCreatorRecipient` admin function — the creator triggers the claim, but
    ///         WETH lands at whatever address the admin most recently routed to.
    function claim(address token) external returns (uint256 amount) {
        TokenInfo storage info = _info[token];
        if (!registered[token]) revert UnknownToken();
        address creator = registry.creatorOf(token);
        if (msg.sender != creator) revert NotCreator();
        address recipient = registry.recipientOf(token);
        amount = info.accrued - info.claimed;
        if (amount > 0) {
            info.claimed = info.accrued;
            lastSeenBalance -= amount;
            IERC20(weth).safeTransfer(recipient, amount);
            emit CreatorFeeClaimed(token, recipient, amount);
        }
    }
}
