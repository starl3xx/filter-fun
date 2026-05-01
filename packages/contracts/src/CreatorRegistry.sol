// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title CreatorRegistry
/// @notice Singleton mapping (token → creator) populated by the FilterLauncher at launch
///         time and never overwritten. Also records the launch timestamp so downstream
///         consumers (notably `CreatorFeeDistributor`) can compute the 72-hour (Days 1–3)
///         creator-fee window without re-reading the launcher. Distinct from the Day 4 hard
///         cut at hour 96 — see `docs/zombie-tokens.md` and `packages/cadence/`.
///
///         Kept deliberately tiny: a write-once registry with a launcher-only writer. No
///         creator transfer, no rotation. Future iterations may add "creator profiles" or
///         soulbound creator credentials on top of this primitive.
contract CreatorRegistry {
    address public immutable launcher;

    mapping(address => address) public creatorOf;
    mapping(address => uint256) public launchedAt;

    event CreatorRegistered(address indexed token, address indexed creator, uint256 launchedAt);

    error NotLauncher();
    error AlreadyRegistered();
    error ZeroToken();
    error ZeroCreator();

    constructor(address launcher_) {
        launcher = launcher_;
    }

    /// @notice Records the (token, creator) pair. Called by the launcher's `_launch` path
    ///         immediately after the token is deployed. Reverts on a re-register attempt
    ///         so the mapping is permanent.
    function register(address token, address creator) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (token == address(0)) revert ZeroToken();
        if (creator == address(0)) revert ZeroCreator();
        if (creatorOf[token] != address(0)) revert AlreadyRegistered();
        creatorOf[token] = creator;
        launchedAt[token] = block.timestamp;
        emit CreatorRegistered(token, creator, block.timestamp);
    }

    /// @notice True iff the token has been registered. Distinguishes "not yet launched" from
    ///         "creator is the zero address" (which is impossible — `register` rejects it).
    function isRegistered(address token) external view returns (bool) {
        return creatorOf[token] != address(0);
    }
}
