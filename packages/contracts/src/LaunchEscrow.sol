// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LaunchEscrow
/// @notice Per-season reservation escrow for the deferred-activation launch model (spec §46).
///
///         Rather than deploying tokens immediately at launch-fee-paid time (the pre-§46
///         "launch immediately, soft-cancel on sparse weeks" model), the launcher routes every
///         reservation through this contract. ETH sits here until ONE of two outcomes lands at
///         hour 48 of the launch window:
///
///           - Activation (≥ 4 reservations landed): the launcher calls `releaseToDeploy` for
///             each reservation, pulling the escrowed ETH back so the deploy path can either
///             retain it as a refundable stake or forward it to the treasury per the launcher's
///             `refundableStakeEnabled` toggle.
///           - Abort (< 4 reservations landed): the launcher calls `refundAll`; this loops the
///             season's reservations and returns each escrow to its creator. Tokens were never
///             deployed — there's nothing to settle, just funds to return.
///
///         Per-wallet cap of ONE reservation per season (spec §4.6) is enforced structurally
///         here: a creator with `escrows[seasonId][creator].amount != 0` gets `AlreadyReserved`
///         on a second `reserve` call. This complements the launcher's per-wallet check —
///         the escrow guard is the structural source of truth, the launcher's check is a
///         clearer revert path before the funds-side guard.
///
///         Authorisation:
///           - `reserve` / `releaseToDeploy` / `refundAll` are all gated `onlyLauncher`. The
///             launcher is the orchestrator that owns the season-state machine; everything
///             else flows through it. No direct external entry on this contract — its job is
///             pure custody, not policy.
contract LaunchEscrow is ReentrancyGuard {
    error NotLauncher();
    error AlreadyReserved();
    error EscrowMismatch();
    error ReleaseFailed();
    error SeasonAlreadyActivated();
    error SeasonAlreadyAborted();
    error UnknownReservation();
    error ZeroAddress();
    error NoPendingRefund();
    error PendingRefundFailed();

    event SlotReserved(
        uint256 indexed seasonId,
        address indexed creator,
        uint256 slotIndex,
        bytes32 indexed tickerHash,
        bytes32 metadataHash,
        uint256 escrowAmount
    );
    event ReservationReleased(uint256 indexed seasonId, address indexed creator, uint256 amount);
    event ReservationRefunded(uint256 indexed seasonId, address indexed creator, uint256 amount);
    /// @notice Emitted when a single creator's refund push fails during `refundAll` (e.g. their
    ///         receiver reverts or runs out of gas). The sweep continues; the failed amount is
    ///         credited to `pendingRefunds[seasonId][creator]` and the creator (or, for a
    ///         contract creator with a broken `receive()`, any address that contract delegates
    ///         to) can pull the funds out via `claimPendingRefund`.
    event RefundFailed(uint256 indexed seasonId, address indexed creator, uint256 amount);
    /// @notice Emitted when a creator (or their delegated `to`) successfully pulls a previously
    ///         stuck refund out of the escrow via `claimPendingRefund`.
    event PendingRefundClaimed(uint256 indexed seasonId, address indexed creator, address to, uint256 amount);
    event SeasonAborted(uint256 indexed seasonId, uint256 reservationCount, uint256 totalRefunded);

    /// @notice Per-(season, creator) escrow record. Tracks both the ETH amount and lifecycle
    ///         flags so we can distinguish "released to deploy" from "refunded after abort"
    ///         from "still escrowed" without separate sentinels.
    /// @dev    Packs into two storage slots: (uint128, uint64, uint64) + (bytes32 + bytes32 +
    ///         bool + bool). `slotIndex` is uint64 because MAX_LAUNCHES is 12; `reservedAt` is
    ///         uint64 because block.timestamp fits comfortably until year 292277026596.
    struct Reservation {
        uint128 amount;
        uint64 reservedAt;
        uint64 slotIndex;
        bytes32 tickerHash;
        bytes32 metadataHash;
        bool released;
        bool refunded;
    }

    /// @notice Address of the FilterLauncher allowed to drive reserve/release/refund. Set
    ///         immutably at construction since the launcher and escrow have a 1:1 lifetime
    ///         relationship — a new launcher requires a new escrow (and a new season cohort).
    address public immutable launcher;

    /// @notice Per-(seasonId → creator → reservation) escrow records. Indexed twice so we can
    ///         resolve "is this creator already reserved?" in O(1) and iterate via the
    ///         parallel `reservers[seasonId]` array on abort.
    mapping(uint256 => mapping(address => Reservation)) internal _escrows;

    /// @notice Ordered list of creators that reserved in `seasonId`, in slot-index order. Used
    ///         by `refundAll` to iterate without rebuilding the list. Append-only.
    mapping(uint256 => address[]) internal _reservers;

    /// @notice True once `refundAll` swept the season. Prevents double-abort and prevents an
    ///         abort from racing a later release (which itself would revert because every
    ///         reservation is `refunded == true` after the sweep, but the season-level flag
    ///         documents the terminal state more clearly for the indexer).
    mapping(uint256 => bool) public aborted;

    /// @notice True once at least one reservation has been released to deploy in `seasonId`.
    ///         Prevents `refundAll` from running on an already-activated season; the launcher
    ///         only calls `refundAll` if `season.activated == false` at h48 anyway, but the
    ///         redundant guard here keeps the escrow defensible standalone.
    mapping(uint256 => bool) public activated;

    /// @notice Pending refund credit for `(seasonId → creator)` whose push-refund failed during
    ///         `refundAll` (their `receive()` reverted, ran out of gas, etc.). The credit can
    ///         be pulled by the creator at any time via `claimPendingRefund(seasonId, to)` —
    ///         no admin involvement required, no time limit, and no dependency on the season's
    ///         lifecycle (the season can stay in the `aborted` terminal state forever and the
    ///         creator's funds remain claimable). Audit: bugbot M PR #88 — replaces the prior
    ///         `r.refunded = false` rollback model that would brick funds when combined with
    ///         the `aborted[seasonId] = true` flag (which permanently blocks `refundAll`).
    mapping(uint256 => mapping(address => uint128)) public pendingRefunds;

    modifier onlyLauncher() {
        if (msg.sender != launcher) revert NotLauncher();
        _;
    }

    constructor(address launcher_) {
        if (launcher_ == address(0)) revert ZeroAddress();
        launcher = launcher_;
    }

    // ============================================================ Reserve

    /// @notice Record a reservation and accept the escrow. Called by the launcher inside its
    ///         `reserve(...)` public entry, AFTER all 8-step validation checks have passed.
    ///         The launcher enforces the slot-cap, ticker-uniqueness, blocklist, and window-
    ///         open checks; the escrow only enforces the per-wallet cap (one reservation per
    ///         creator per season) plus the funds-attached check.
    /// @param  seasonId       Season being reserved into.
    /// @param  creator        EOA reserving (passed through from launcher's `msg.sender`).
    /// @param  slotIndex      Pre-increment slot ordinal assigned by the launcher.
    /// @param  tickerHash     `TickerLib.hashOf(ticker)`; emitted indexed for indexer queries.
    /// @param  metadataHash   Off-chain metadata commitment; opaque on-chain.
    /// @dev    `payable` and forwards `msg.value` from the launcher. The launcher's
    ///         `_releaseToDeploy` path subsequently pulls the same amount back via
    ///         `releaseToDeploy`, completing the round-trip.
    function reserve(
        uint256 seasonId,
        address creator,
        uint256 slotIndex,
        bytes32 tickerHash,
        bytes32 metadataHash
    ) external payable onlyLauncher nonReentrant {
        if (creator == address(0)) revert ZeroAddress();
        if (aborted[seasonId]) revert SeasonAlreadyAborted();
        Reservation storage r = _escrows[seasonId][creator];
        // Per-wallet cap: existence is keyed off `reservedAt != 0` rather than `amount != 0`,
        // because a launcher with `baseLaunchCost = 0` produces zero-amount reservations that
        // are nonetheless valid records. The launcher's external pre-check already mirrors
        // this; the structural guard here uses the same sentinel for consistency.
        if (r.reservedAt != 0) revert AlreadyReserved();

        r.amount = uint128(msg.value);
        r.reservedAt = uint64(block.timestamp);
        r.slotIndex = uint64(slotIndex);
        r.tickerHash = tickerHash;
        r.metadataHash = metadataHash;
        // released + refunded default false.

        _reservers[seasonId].push(creator);

        emit SlotReserved(seasonId, creator, slotIndex, tickerHash, metadataHash, msg.value);
    }

    // ============================================================ Release (deploy path)

    /// @notice Returns the escrowed ETH for `(seasonId, creator)` to the launcher so the
    ///         deploy path can either retain it as a refundable stake or forward it to
    ///         treasury. Marks the reservation `released = true` and the season `activated`.
    /// @dev    `nonReentrant` because we transfer ETH back to the launcher; the launcher is
    ///         a trusted party but the cross-contract pattern is consistent with refundAll's
    ///         external-call discipline.
    function releaseToDeploy(uint256 seasonId, address creator)
        external
        onlyLauncher
        nonReentrant
        returns (uint256 amount)
    {
        if (aborted[seasonId]) revert SeasonAlreadyAborted();
        Reservation storage r = _escrows[seasonId][creator];
        // Existence sentinel is `reservedAt != 0` (matches `reserve` above) so a zero-cost
        // reservation under `baseLaunchCost = 0` still resolves as a real record.
        if (r.reservedAt == 0) revert UnknownReservation();
        if (r.released || r.refunded) revert EscrowMismatch();

        amount = uint256(r.amount);
        r.released = true;
        // Don't zero `r.amount` — the indexer reads it post-fact for reconciliation and
        // `released == true` is the lifecycle source of truth.
        activated[seasonId] = true;

        if (amount > 0) {
            (bool ok,) = launcher.call{value: amount}("");
            if (!ok) revert ReleaseFailed();
        }
        emit ReservationReleased(seasonId, creator, amount);
    }

    // ============================================================ Refund (abort path)

    /// @notice Sweep every reservation for `seasonId`, returning each escrow to its creator.
    ///         Called by the launcher exactly once when the launch window closes with fewer
    ///         than the activation threshold of reservations. The launcher gates this on
    ///         `season.activated == false` AND `block.timestamp >= launchEndTime`; we add the
    ///         redundant `!activated[seasonId]` guard here so the escrow is defensible
    ///         standalone (a future caller can't trick us into refunding a live cohort).
    /// @dev    A single failed refund tx (because the creator is a contract whose receive()
    ///         reverts, or runs out of gas) credits `pendingRefunds[seasonId][creator]` and
    ///         emits `RefundFailed`; the sweep continues. The creator can pull the credit via
    ///         `claimPendingRefund` at any later time. We do NOT revert the whole sweep on
    ///         one bad recipient — that would let any single griefer brick the entire season's
    ///         refund. Audit: bugbot M PR #88 — pull-pattern fallback replaces the prior
    ///         `r.refunded = false` rollback that would have permanently locked funds (since
    ///         the `aborted[seasonId] = true` flag set above blocks both this function and
    ///         `releaseToDeploy` from ever being called again for this season).
    function refundAll(uint256 seasonId)
        external
        onlyLauncher
        nonReentrant
        returns (uint256 reservationCount, uint256 totalRefunded)
    {
        if (activated[seasonId]) revert SeasonAlreadyActivated();
        if (aborted[seasonId]) revert SeasonAlreadyAborted();

        aborted[seasonId] = true;

        address[] storage list = _reservers[seasonId];
        reservationCount = list.length;

        for (uint256 i = 0; i < reservationCount; ++i) {
            address creator = list[i];
            Reservation storage r = _escrows[seasonId][creator];
            // Safety net: skip already-released/refunded entries. Reachable only through a
            // future code path that touches reservations between reserve and refundAll;
            // current launcher flow guarantees clean state here.
            if (r.released || r.refunded) continue;
            uint256 amount = uint256(r.amount);
            r.refunded = true;
            if (amount == 0) {
                emit ReservationRefunded(seasonId, creator, 0);
                continue;
            }
            (bool ok,) = creator.call{value: amount}("");
            if (!ok) {
                // Push failed; credit the amount to the pull-pattern map so the creator can
                // claim later via `claimPendingRefund(seasonId, to)`. We KEEP `r.refunded = true`
                // so a re-run of `refundAll` (defensive; it's gated by `aborted[seasonId]`
                // anyway) doesn't double-credit. The pending map is now the source of truth
                // for the stuck amount.
                pendingRefunds[seasonId][creator] = uint128(amount);
                emit RefundFailed(seasonId, creator, amount);
                continue;
            }
            totalRefunded += amount;
            emit ReservationRefunded(seasonId, creator, amount);
        }

        emit SeasonAborted(seasonId, reservationCount, totalRefunded);
    }

    // ============================================================ Rescue (pull-pattern)

    /// @notice Pull a stuck refund out of the escrow after a failed push during `refundAll`.
    ///         Self-only: `msg.sender` must be the original creator (the address that holds the
    ///         credit in `pendingRefunds`). The recipient `to` is parameterised so a contract
    ///         creator whose own `receive()` reverted (the exact case that put the funds into
    ///         pull mode) can redirect to a fresh EOA / proxy that accepts ETH. EOA creators
    ///         that simply ran out of gas in the original sweep can pass `payable(msg.sender)`.
    /// @dev    Audit: bugbot M PR #88. There is no time limit and no admin gate — the credit
    ///         is the creator's permanent claim on their escrow. `nonReentrant` because the
    ///         `to` recipient is arbitrary and may itself try to re-enter.
    function claimPendingRefund(uint256 seasonId, address payable to)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (to == address(0)) revert ZeroAddress();
        amount = uint256(pendingRefunds[seasonId][msg.sender]);
        if (amount == 0) revert NoPendingRefund();
        delete pendingRefunds[seasonId][msg.sender];
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PendingRefundFailed();
        emit PendingRefundClaimed(seasonId, msg.sender, to, amount);
    }

    // ============================================================ Views

    /// @notice Live escrow record. Returned by struct so the indexer can pull every field in
    ///         a single call.
    function escrowOf(uint256 seasonId, address creator) external view returns (Reservation memory) {
        return _escrows[seasonId][creator];
    }

    function reservers(uint256 seasonId) external view returns (address[] memory) {
        return _reservers[seasonId];
    }

    function reservationCountOf(uint256 seasonId) external view returns (uint256) {
        return _reservers[seasonId].length;
    }

    /// @notice Lightweight existence check used by the launcher's per-wallet cap. Reading just
    ///         this scalar avoids decoding the full `Reservation` struct from `escrowOf`,
    ///         which costs ~100 bytes of bytecode in the launcher's hot path.
    function reservedAtOf(uint256 seasonId, address creator) external view returns (uint64) {
        return _escrows[seasonId][creator].reservedAt;
    }

    /// @notice Receive funds released by the launcher's deploy-path or any direct deposit.
    ///         The launcher pre-funds via `reserve{value: cost}` and pulls back via
    ///         `releaseToDeploy`; these are the only expected money-flows on this contract.
    receive() external payable {}
}
