// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IMaliciousReceiverHook {
    function onTokenHook() external;
}

/// @title MaliciousReceiver
/// @notice Reusable reentrancy attacker for §42.1 threat #3 (reentrancy attacker). One contract,
///         three plug-in surfaces:
///
///           - **ETH receive**: `receive()` and `fallback()` invoke the armed callback. Anything
///             that does `msg.sender.call{value:x}("")` while this contract is the recipient
///             triggers the re-entry attempt.
///           - **ERC20 transfer hook**: for ERC20s that don't natively run a callback on
///             `_update` (the OZ default), use `MaliciousERC20` (below) as the actual token
///             contract and wire its `hookTarget` to this receiver. Any `transfer`/`mint`/
///             `safeTransfer` involving the malicious token fires `onTokenHook` here.
///           - **V4 hook callback / arbitrary external call**: the `armOnExternalCall` mode
///             lets any cooperating mock (e.g. a hook stub) call `onExternalHook` to trigger
///             the same re-entry path. Useful for V4 BeforeAddLiquidity / BeforeRemoveLiquidity
///             hook simulations.
///
///         Arming/disarming:
///           - `arm(target, callbackData)` sets the target call to attempt on next hook fire.
///           - The callback fires *exactly once* per arm cycle: after firing, `armed` flips
///             false so a real cleanup transfer (e.g. the legitimate function send) doesn't
///             attempt a second nested re-entry which would itself revert and mask the test.
///           - `disarm()` clears the target without firing.
///
///         What the test checks:
///           - `reentryAttempted` flips true when the hook ran the callback (proof the attack
///             surface fired).
///           - `reentrySucceeded` flips true if `target.call(callbackData)` returned `true` —
///             which the protected functions MUST NOT permit. ReentrancyGuard should bubble a
///             `ReentrancyGuardReentrantCall` revert, which lands `success == false` here.
///
///         The receiver itself is intentionally permissionless — invariant tests can use the
///         same instance across many fuzz sequences. State (`armed`, `reentryAttempted`,
///         `reentrySucceeded`) is reset by `arm` so each attack cycle is observable.
contract MaliciousReceiver is IMaliciousReceiverHook {
    address public target;
    bytes public callbackData;
    bool public armed;

    /// @notice Set true the moment the hook fires. Stays true across the whole test run unless
    ///         the test calls `clear()` (used by invariant tests as a sticky "an attack ran" flag).
    bool public reentryAttempted;
    /// @notice True iff the inner `target.call(callbackData)` returned success — i.e. the
    ///         protected function did NOT revert. Any non-false value here is a test failure
    ///         per invariant 5 (reentrancy safety).
    bool public reentrySucceeded;

    event Armed(address indexed target, bytes data);
    event HookFired(address indexed target, bool success);

    /// @notice Arm a re-entry attempt. Resets `armed` to true and clears the per-cycle
    ///         outcome flags so a fresh attack is observable. Sticky `reentrySucceeded`
    ///         persists across arm cycles — clear it explicitly via `clear()` if needed.
    function arm(address target_, bytes calldata callbackData_) external {
        target = target_;
        callbackData = callbackData_;
        armed = true;
        emit Armed(target_, callbackData_);
    }

    /// @notice Disarm without clearing the success flag (useful between fuzz sequences).
    function disarm() external {
        armed = false;
    }

    /// @notice Reset every flag. Tests use this between independent attack cycles.
    function clear() external {
        armed = false;
        reentryAttempted = false;
        reentrySucceeded = false;
        target = address(0);
        delete callbackData;
    }

    /// @notice ETH path — invoked by any `address(this).call{value:x}("")` send. The check is
    ///         armed-then-disarm so we don't recurse infinitely on the legitimate post-revert
    ///         cleanup.
    receive() external payable {
        _fire();
    }

    fallback() external payable {
        _fire();
    }

    /// @notice ERC20 path — invoked by `MaliciousERC20._update` when the malicious token is
    ///         the medium and this receiver is wired as `hookTarget`.
    function onTokenHook() external override {
        _fire();
    }

    /// @notice Generic external-call path — any cooperating contract (V4 hook stub, mock
    ///         callback) can invoke this to trigger the same re-entry attempt.
    function onExternalHook() external {
        _fire();
    }

    function _fire() internal {
        if (!armed) return;
        // Disarm first so the target's own internal calls (e.g. residual cleanup from the
        // original transfer that brought us here) don't recursively retrigger.
        armed = false;
        reentryAttempted = true;

        (bool ok,) = target.call(callbackData);
        if (ok) reentrySucceeded = true;
        emit HookFired(target, ok);
    }
}

/// @title MaliciousERC20
/// @notice Drop-in for the OZ ERC20 with a transfer-hook side channel. Plug a `MaliciousReceiver`
///         in via `setHook(address)` and every `_update` (mint, transfer, transferFrom) fires the
///         hook before completing the balance update. Mirrors what an attacker would do if they
///         could substitute their own token implementation as the winner / loser ERC20 — proves
///         the protocol's ReentrancyGuard catches the re-entry even when the *token contract
///         itself* is hostile.
///
///         The hook is opt-in (zero-address default) so the same contract can serve as a
///         baseline ERC20 in non-attack tests.
contract MaliciousERC20 is ERC20 {
    address public hookTarget;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function setHook(address hookTarget_) external {
        hookTarget = hookTarget_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev OZ's `ERC20._update` is the single point that handles mint/burn/transfer balance
    ///      moves. Firing the hook here covers every path the protocol code can take.
    function _update(address from, address to, uint256 value) internal override {
        address h = hookTarget;
        if (h != address(0)) IMaliciousReceiverHook(h).onTokenHook();
        super._update(from, to, value);
    }
}
