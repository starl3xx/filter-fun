// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CreatorRegistry} from "./CreatorRegistry.sol";

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
    function vaultOf(uint256 seasonId) external view returns (address);
    function owner() external view returns (address);
}

/// @title CreatorFeeDistributor
/// @notice Singleton sink for the 0.20% creator slice of every swap. Accrues per-token,
///         claimable by the registered creator. Per spec §10.3 (locked 2026-05-02), creator-fee
///         accrual is PERPETUAL — there is no time cap and no settlement cap.
///
///         The fee stream stops naturally for any pool whose LP is unwound (filtered tokens at
///         h96, non-winning finalists at h168) because the pool no longer trades. Winner pools
///         keep trading forever, so their creators keep earning forever. The cap is implicit in
///         the pool lifecycle, not enforced in this contract.
///
///         Auth model:
///         - `notifyFee` is callable only by the active `FilterLpLocker` for that token
///           (verified via `launcher.lockerOf`).
///         - `disableCreatorFee` is callable only by the launcher's owner (the deployer
///           multisig). Reserved for emergency use — sanctioned/compromised recipient address.
///           Once disabled, further accrual redirects to treasury until re-enabled by upgrade
///           (this iteration deliberately omits a re-enable path; emergency means emergency).
///         - `claim` is callable only by the registered creator.
contract CreatorFeeDistributor {
    using SafeERC20 for IERC20;

    address public immutable launcher;
    address public immutable weth;
    address public immutable treasury;
    CreatorRegistry public immutable registry;

    /// @notice Tracks per-token accrual state. `seasonId` lets `notifyFee` verify its caller
    ///         without re-reading the launcher each time.
    struct TokenInfo {
        uint256 seasonId;
        bool disabled; // emergency multisig flag; see `disableCreatorFee`
        uint256 accrued; // total credited (across history, never decreases)
        uint256 claimed; // total withdrawn
    }

    mapping(address => TokenInfo) internal _info;
    mapping(address => bool) public registered;

    /// @notice Tracks last-seen WETH balance so `notifyFee` can verify the locker actually
    ///         transferred the WETH in this tx (vs. faking a bookkeeping call).
    /// @dev    Audit I-Contracts-5 (Phase 1, 2026-05-01): the `currentBalance < lastSeenBalance
    ///         + amount` check assumes sequential, single-locker calls per token — which holds
    ///         today because (a) every token has exactly one `FilterLpLocker` (factory-deployed,
    ///         immutable) and (b) every notify is gated to that locker. If a future iteration
    ///         introduces a second contract that pushes WETH directly to this distributor
    ///         (e.g., a sponsor-fee router), or splits a single locker into a multi-caller
    ///         pool, the snapshot accounting will skew and the underflow on
    ///         `lastSeenBalance -= amount` (in the redirect/claim paths) becomes the failure
    ///         mode. Re-validate this assumption before adding any new caller surface.
    uint256 public lastSeenBalance;

    event TokenRegistered(address indexed token, uint256 indexed seasonId);
    event CreatorFeeAccrued(address indexed token, address indexed creator, uint256 amount);
    event CreatorFeeRedirected(address indexed token, uint256 amount);
    event CreatorFeeClaimed(address indexed token, address indexed recipient, uint256 amount);
    /// @notice Emitted when the multisig disables the creator stream for a token. Reserved for
    ///         emergency use (sanctioned/compromised recipient). Not part of the normal token
    ///         lifecycle — filtered + non-winning tokens lose their fee stream by virtue of LP
    ///         unwind, not by emitting this event.
    event CreatorFeeDisabled(address indexed token);
    /// @notice Operator audit-trail signal (Epic 1.21 / spec §47.4). Emitted from
    ///         operator-callable functions so the indexer's `OperatorActionLog` table
    ///         captures actor + decoded params without per-event schemas.
    event OperatorActionEmitted(address indexed actor, string action, bytes params);

    error NotLauncher();
    error NotRegisteredLocker();
    error NotMultisig();
    error NotCreator();
    error AlreadyRegistered();
    error UnknownToken();
    error UnverifiedTransfer();
    error EmptyReason();
    error Disabled();

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

    function pendingClaim(address token) external view returns (uint256) {
        TokenInfo storage i = _info[token];
        return i.accrued - i.claimed;
    }

    /// @notice Convenience view: a token is currently earning unless it's been emergency-
    ///         disabled. Pool-lifecycle termination (LP unwind) is observable off-chain via the
    ///         locker's `liquidated` flag — this view doesn't conflate the two.
    function isDisabled(address token) external view returns (bool) {
        return _info[token].disabled;
    }

    /// @notice Launcher records the (token, seasonId) at launch time. The creator is read from
    ///         the registry; we just stash the seasonId so the per-token auth check in
    ///         `notifyFee` can verify its caller.
    function registerToken(address token, uint256 seasonId) external onlyLauncher {
        if (registered[token]) revert AlreadyRegistered();
        registered[token] = true;
        _info[token].seasonId = seasonId;
        emit TokenRegistered(token, seasonId);
    }

    /// @notice Locker calls after `poolManager.take`-ing the WETH directly into this contract.
    ///         We verify the balance grew by the claimed amount, then either credit the creator
    ///         (the normal path, perpetual per spec §10.3) or — if the multisig has disabled
    ///         this token — redirect to treasury so the BPS invariants stay honest.
    function notifyFee(address token, uint256 amount) external {
        TokenInfo storage info = _info[token];
        if (!registered[token]) revert UnknownToken();
        address expectedLocker = ILauncherView(launcher).lockerOf(info.seasonId, token);
        if (msg.sender != expectedLocker) revert NotRegisteredLocker();

        uint256 currentBalance = IERC20(weth).balanceOf(address(this));
        if (currentBalance < lastSeenBalance + amount) revert UnverifiedTransfer();
        lastSeenBalance = currentBalance;

        if (info.disabled) {
            // Multisig-disabled (emergency): protocol still collects the slice; the creator
            // doesn't, because the recipient address is sanctioned/compromised.
            lastSeenBalance -= amount;
            IERC20(weth).safeTransfer(treasury, amount);
            emit CreatorFeeRedirected(token, amount);
        } else {
            address creator = registry.creatorOf(token);
            info.accrued += amount;
            emit CreatorFeeAccrued(token, creator, amount);
        }
    }

    /// @notice Multisig-only emergency disable (spec §10.6, Epic 1.21 §47.4.2). Redirects
    ///         future fees to treasury AND sweeps any already-accrued pending balance to
    ///         treasury so a sanctioned recipient cannot pull pre-disable funds via
    ///         `claim`. Use case: the registered recipient is sanctioned, compromised, or
    ///         otherwise disqualified.
    ///
    ///         Idempotent state change (second call has no pending to sweep because
    ///         `notifyFee` redirects directly when disabled), but the audit-trail event
    ///         re-emits on every call so the indexer's `OperatorActionLog` records every
    ///         operator attempt — operators sometimes re-call to log a follow-up reason
    ///         after the initial disable.
    ///
    ///         A free-text `reason` is required (logged on `OperatorActionEmitted`) so
    ///         post-hoc forensics can attribute the disable; an empty reason reverts with
    ///         `EmptyReason()` to keep the audit log meaningful.
    /// @dev    Authority is read live from `Ownable(launcher).owner()` — same pattern as
    ///         the vault's live-oracle read (audit H-2). An ownership transfer on the
    ///         launcher takes effect on this gate immediately, no per-distributor wire.
    function disableCreatorFee(address token, string calldata reason) external {
        if (msg.sender != Ownable(launcher).owner()) revert NotMultisig();
        if (bytes(reason).length == 0) revert EmptyReason();
        if (!registered[token]) revert UnknownToken();
        TokenInfo storage info = _info[token];

        // Audit-trail emission BEFORE the idempotent early-return so re-calls
        // still log a row in the indexer's `OperatorActionLog`. Operators
        // sometimes re-disable to attach a follow-up `reason` (e.g.
        // additional forensic context after the initial disable).
        emit OperatorActionEmitted(msg.sender, "disableCreatorFee", abi.encode(token, reason));

        if (info.disabled) return;
        info.disabled = true;
        emit CreatorFeeDisabled(token);

        // Sweep pending: closes the gap where a sanctioned recipient could still call
        // `claim` and drain pre-disable accrual to the very address the disable was meant
        // to lock out. Treasury captures it instead, mirroring the disabled `notifyFee` path.
        uint256 pending = info.accrued - info.claimed;
        if (pending > 0) {
            info.claimed = info.accrued;
            lastSeenBalance -= pending;
            IERC20(weth).safeTransfer(treasury, pending);
            emit CreatorFeeRedirected(token, pending);
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
    ///
    ///         Per spec §10.3 + §10.6: there is NO claim cap and NO max payout per token. A
    ///         winning creator keeps pulling claims forever as their pool keeps trading.
    function claim(address token) external returns (uint256 amount) {
        TokenInfo storage info = _info[token];
        if (!registered[token]) revert UnknownToken();
        if (info.disabled) revert Disabled();
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
