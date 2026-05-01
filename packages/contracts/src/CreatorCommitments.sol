// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CreatorRegistry} from "./CreatorRegistry.sol";

/// @title CreatorCommitments
/// @notice Opt-in, monotonically-increasing time-lock on a creator's own bag — the on-chain
///         primitive behind filter.fun's bag-lock differentiator (spec §38.5 / §38.8).
///
///         Auth model:
///         - Only the creator-of-record (per `CreatorRegistry.creatorOf`) can call `commit` for
///           a given token. Admin transfers (`CreatorRegistry.adminOf`) are intentionally NOT
///           accepted: a bag-lock is a personal commitment by the original launcher, not a
///           transferable role. If the creator hands admin to a multisig and that multisig
///           tries to commit, the call reverts.
///         - The mapping is keyed by `(creator, token)`. The transfer-gating hook on the token
///           reads `isLocked(from, address(this))` so the lock follows the creator's address —
///           any address that ends up holding tokens but isn't the locked creator is unaffected.
///
///         Structural guarantees (audit-relevant — spec §38.7):
///         - Locks can ONLY extend, never shorten. The contract has no "unlock", no "cancel",
///           no admin override, no pause. If a security issue is found post-deploy the only
///           remediation is to deploy a new contract; locks recorded on the existing instance
///           remain enforced for as long as the FilterToken contracts that reference it exist.
///         - Reentrancy-guarded on the only state-mutating function.
///         - All effects emit `Committed` so indexers can rebuild the locked-status surface
///           from a single log topic.
///
///         What the lock does NOT do (must be communicated loudly in UI, see docs/bag-lock.md):
///         - It does not retroactively cover tokens the creator transferred to other wallets
///           BEFORE committing — those tokens move freely. The lock applies to the locker's
///           wallet balance only.
///         - It does not prevent the creator from buying more tokens — incoming transfers
///           still credit the locked address; only outgoing transfers from it are gated.
///         - It does not prevent the creator from losing the key. A locked creator who loses
///           access to their wallet has permanently locked the bag (by design — that's what
///           makes the lock credible).
contract CreatorCommitments is ReentrancyGuard {
    /// @notice Singleton `CreatorRegistry` whose `creatorOf` mapping authorizes every commit.
    ///         Immutable so the auth surface can't be moved by anyone, including this contract's
    ///         deployer.
    CreatorRegistry public immutable creatorRegistry;

    /// @notice (creator, token) → unix timestamp at which the lock expires. A value strictly
    ///         greater than `block.timestamp` means the creator's balance of `token` is locked.
    ///         Zero is the "no lock" default. Once non-zero, monotonically increases.
    mapping(address creator => mapping(address token => uint256 unlockTimestamp)) public unlockTimestamps;

    /// @notice Emitted on every successful `commit`. `previousUnlock` is the value the lock
    ///         held before this call (zero on first commit) so indexers don't need a separate
    ///         read to render lock-extension diffs.
    event Committed(
        address indexed creator, address indexed token, uint256 lockUntil, uint256 previousUnlock
    );

    error TokenNotRegistered();
    error NotCreator();
    error LockMustBeFuture();
    error LockCannotShorten();

    constructor(CreatorRegistry creatorRegistry_) {
        creatorRegistry = creatorRegistry_;
    }

    /// @notice Lock or extend the caller's bag of `token` until `lockUntil`. The caller must be
    ///         the creator-of-record for `token`. The new unlock time must be strictly in the
    ///         future AND strictly later than any existing unlock (locks never shorten).
    /// @dev    Use `type(uint256).max` to lock forever — explicitly allowed; the token's gate
    ///         will revert on every transfer from the creator's address indefinitely.
    function commit(address token, uint256 lockUntil) external nonReentrant {
        // `creatorOf` is zero for unregistered tokens; check this first so an admin who typoed
        // a token address gets `TokenNotRegistered` instead of the less-helpful `NotCreator`.
        address creator = creatorRegistry.creatorOf(token);
        if (creator == address(0)) revert TokenNotRegistered();
        if (msg.sender != creator) revert NotCreator();
        // Strict `>` so a creator can't no-op-commit at the current block (would be zero-cost
        // griefing of the indexer with empty-extend events).
        if (lockUntil <= block.timestamp) revert LockMustBeFuture();
        uint256 previous = unlockTimestamps[creator][token];
        if (lockUntil <= previous) revert LockCannotShorten();
        unlockTimestamps[creator][token] = lockUntil;
        emit Committed(creator, token, lockUntil, previous);
    }

    /// @notice True iff `creator`'s balance of `token` is currently locked. Used by the token's
    ///         transfer hook to gate outgoing transfers from `creator`.
    /// @dev    Strict `<` (not `<=`) so a transfer in the same block as `lockUntil` is allowed:
    ///         the lock expires AT `lockUntil`. Symmetric with `commit`'s `<=` check (which
    ///         requires `lockUntil > block.timestamp`), so a freshly-committed lock is locked
    ///         in the very next block.
    function isLocked(address creator, address token) external view returns (bool) {
        return block.timestamp < unlockTimestamps[creator][token];
    }

    /// @notice Read the raw unlock timestamp for `(creator, token)`. Zero means no lock has
    ///         ever been recorded; non-zero means there is or was a lock that may have expired.
    ///         UI uses this to display "locked until <date>" / "unlocked since <date>" without
    ///         a separate boolean.
    function unlockOf(address creator, address token) external view returns (uint256) {
        return unlockTimestamps[creator][token];
    }
}
