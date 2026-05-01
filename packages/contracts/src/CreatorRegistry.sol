// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CreatorRegistry
/// @notice Singleton mapping (token → creator) populated by the FilterLauncher at launch
///         time and never overwritten. Also records the launch timestamp so downstream
///         consumers (notably `CreatorFeeDistributor`) can compute the 72-hour (Days 1–3)
///         creator-fee window without re-reading the launcher. Distinct from the Day 4 hard
///         cut at hour 96 — see `docs/zombie-tokens.md` and `packages/cadence/`.
///
///         Identity vs. control vs. payout (Epic 1.12, spec §38.6):
///         - `creatorOf` is the immutable identity of who launched the token. Never moves.
///         - `adminOf` is the wallet permitted to mutate metadata / recipient / admin. Defaults
///           to the creator until explicitly transferred via the two-step nominate→accept flow.
///         - `recipientOf` is where the 0.20% creator fee flows on `claim`. Defaults to the
///           creator until the admin sets a different address.
///
///         Defaults are encoded as zero in the override mappings — pre-1.12 tokens (e.g.
///         Sepolia tokens deployed before this version) read the same view-function shape and
///         resolve admin/recipient back to the creator with no migration step required.
contract CreatorRegistry is ReentrancyGuard {
    address public immutable launcher;

    mapping(address => address) public creatorOf;
    mapping(address => uint256) public launchedAt;

    /// @notice Per-token override of the active admin. Zero means "use creatorOf as admin".
    ///         The two-step transfer (`nominateAdmin` → `acceptAdmin`) writes here.
    mapping(address => address) public adminOverrideOf;
    /// @notice Address nominated by the current admin and awaiting acceptance. Zero means
    ///         no transfer is pending. Cleared on accept or cancel.
    mapping(address => address) public pendingAdminOf;
    /// @notice Per-token override of the creator-fee recipient. Zero means "use creatorOf
    ///         as recipient". `CreatorFeeDistributor.claim` reads `recipientOf` and pays
    ///         the resolved address.
    mapping(address => address) public recipientOverrideOf;
    /// @notice Mutable on-chain metadata URI (admin-set). Empty string means "no override
    ///         set yet" — readers should fall back to the `TokenLaunched` event's URI for
    ///         the token's launch-time metadata.
    mapping(address => string) internal _metadataURIOf;

    event CreatorRegistered(address indexed token, address indexed creator, uint256 launchedAt);
    event MetadataURIUpdated(address indexed token, address indexed admin, string uri);
    event CreatorRecipientUpdated(
        address indexed token, address indexed oldRecipient, address indexed newRecipient
    );
    event AdminNominated(address indexed token, address indexed currentAdmin, address indexed pendingAdmin);
    event AdminUpdated(address indexed token, address indexed oldAdmin, address indexed newAdmin);
    event AdminNominationCancelled(address indexed token, address indexed pendingAdmin);

    error NotLauncher();
    error AlreadyRegistered();
    error ZeroToken();
    error ZeroCreator();
    error NotRegistered();
    error NotAdmin();
    error NotPendingAdmin();
    error EmptyURI();
    error ZeroRecipient();
    error ZeroPendingAdmin();
    error NoPendingAdmin();

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

    // ============================================================ Admin / recipient resolution

    /// @notice Active admin for `token`. Defaults to the creator until a two-step transfer
    ///         completes. Returns zero for unregistered tokens.
    function adminOf(address token) public view returns (address) {
        address override_ = adminOverrideOf[token];
        return override_ == address(0) ? creatorOf[token] : override_;
    }

    /// @notice Active fee recipient for `token`. Defaults to the creator until the admin
    ///         calls `setCreatorRecipient`. Returns zero for unregistered tokens.
    function recipientOf(address token) public view returns (address) {
        address override_ = recipientOverrideOf[token];
        return override_ == address(0) ? creatorOf[token] : override_;
    }

    /// @notice Mutable on-chain metadata URI for `token`. Empty when never set; readers
    ///         must fall back to the `TokenLaunched` event in that case.
    function metadataURIOf(address token) external view returns (string memory) {
        return _metadataURIOf[token];
    }

    // ============================================================ Admin-gated setters

    /// @dev Common gate for the four admin-only mutators. The `NotRegistered` check runs
    ///      before `NotAdmin` so an unknown token surfaces a more-specific error (admins
    ///      typing the wrong token address shouldn't be told "you're not admin").
    modifier onlyAdmin(address token) {
        if (creatorOf[token] == address(0)) revert NotRegistered();
        if (msg.sender != adminOf(token)) revert NotAdmin();
        _;
    }

    /// @notice Update the on-chain metadata URI. Empty strings are rejected — admins who
    ///         want to clear metadata must point at an explicit empty-state URI.
    function setMetadataURI(address token, string calldata uri) external nonReentrant onlyAdmin(token) {
        if (bytes(uri).length == 0) revert EmptyURI();
        _metadataURIOf[token] = uri;
        emit MetadataURIUpdated(token, msg.sender, uri);
    }

    /// @notice Change where the 0.20% creator fee flows. The new recipient must be non-zero
    ///         (zero would silently re-default to creator and is a likely-typo footgun).
    function setCreatorRecipient(address token, address newRecipient) external nonReentrant onlyAdmin(token) {
        if (newRecipient == address(0)) revert ZeroRecipient();
        address oldRecipient = recipientOf(token);
        recipientOverrideOf[token] = newRecipient;
        emit CreatorRecipientUpdated(token, oldRecipient, newRecipient);
    }

    /// @notice Step 1 of admin transfer — current admin proposes a new admin. The pending
    ///         admin then calls `acceptAdmin` to complete the transfer. Single-step transfer
    ///         is intentionally not offered: it lets an admin lock themselves out by
    ///         nominating a wallet they don't control. See spec §38.6.
    function nominateAdmin(address token, address pendingAdmin) external nonReentrant onlyAdmin(token) {
        if (pendingAdmin == address(0)) revert ZeroPendingAdmin();
        pendingAdminOf[token] = pendingAdmin;
        emit AdminNominated(token, adminOf(token), pendingAdmin);
    }

    /// @notice Step 2 of admin transfer — the nominated wallet accepts. Reverts if the caller
    ///         isn't the pending admin (so admins can't be hijacked by a different wallet
    ///         front-running with the same selector).
    function acceptAdmin(address token) external nonReentrant {
        if (creatorOf[token] == address(0)) revert NotRegistered();
        address pending = pendingAdminOf[token];
        if (pending == address(0)) revert NoPendingAdmin();
        if (msg.sender != pending) revert NotPendingAdmin();
        address oldAdmin = adminOf(token);
        adminOverrideOf[token] = pending;
        delete pendingAdminOf[token];
        emit AdminUpdated(token, oldAdmin, pending);
    }

    /// @notice Admin can rescind an outstanding nomination before it's accepted. Useful
    ///         when the admin realises they nominated the wrong address and wants to
    ///         clean up the pending slot before nominating again.
    function cancelNomination(address token) external nonReentrant onlyAdmin(token) {
        address pending = pendingAdminOf[token];
        if (pending == address(0)) revert NoPendingAdmin();
        delete pendingAdminOf[token];
        emit AdminNominationCancelled(token, pending);
    }
}
