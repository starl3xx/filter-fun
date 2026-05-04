/// LaunchEscrow event handlers — Epic 1.15a deferred-activation lifecycle.
///
/// Tracks every reservation through the state machine (PENDING → RELEASED / REFUNDED /
/// REFUND_PENDING / REFUND_CLAIMED). The launcher fires `FilterLauncher:SeasonAborted`
/// before `LaunchEscrow:SeasonAborted` (storage abort flag set, then escrow loops
/// reservations and emits one `ReservationRefunded` / `RefundFailed` per creator).
/// We rely on this ordering to lazily upsert summary rows when needed.
///
/// Per-creator monetary flow:
///   SlotReserved          — escrow holds `escrowAmount` for the (seasonId, creator) pair
///   ReservationReleased   — slot normalized into a launched token (no refund; eth flowed
///                           through the LP path); fired alongside FilterLauncher.TokenLaunched
///   ReservationRefunded   — abort succeeded the push refund — eth back in creator wallet
///   RefundFailed          — abort tried to push but creator's receive() reverted; escrow
///                           recorded a `pendingRefund` slot — creator must claimPendingRefund
///   PendingRefundClaimed  — creator (or their delegate) drained the pendingRefund slot
///   SeasonAborted         — terminal: escrow finished its abort loop; aggregate counts emitted

import {ponder} from "@/generated";

import {
  broadcastReservationEvent,
  broadcastSeasonStateEvent,
} from "./api/events/launchBroadcast.js";
import {
  launchEscrowSummary,
  pendingRefund,
  reservation,
  seasonTickerReservation,
} from "../ponder.schema";

ponder.on("LaunchEscrow:SlotReserved", async ({event, context}) => {
  const id = `${event.args.seasonId.toString()}:${event.args.creator.toLowerCase()}`;
  await context.db.insert(reservation).values({
    id,
    seasonId: event.args.seasonId,
    creator: event.args.creator,
    slotIndex: event.args.slotIndex,
    tickerHash: event.args.tickerHash,
    metadataHash: event.args.metadataHash,
    escrowAmount: event.args.escrowAmount,
    status: "PENDING",
    reservedAt: event.block.timestamp,
  });
  // Per-season ticker registry — backs the launch-form pre-flight check.
  await context.db.insert(seasonTickerReservation).values({
    id: `${event.args.seasonId.toString()}:${event.args.tickerHash}`,
    seasonId: event.args.seasonId,
    tickerHash: event.args.tickerHash,
    creator: event.args.creator,
    reservedAt: event.block.timestamp,
  });
  // Increment summary counters. Bootstrapped by FilterLauncher:SeasonStarted; the
  // defensive insert here covers a corrupt indexer state (drop happens-before is
  // strict in Ponder so this branch is unreachable in practice).
  //
  // Audit: bugbot M PR #92. The defensive insert MUST fall through to the broadcast
  // — an early-return here silently drops the SSE frame for any reservation that
  // happens to land before the summary row exists, leaving Arena UI clients
  // unaware of the slot. The broadcast is the load-bearing invariant of this
  // handler; the DB shape is secondary.
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  if (!summary) {
    await context.db.insert(launchEscrowSummary).values({
      id: event.args.seasonId,
      reservationCount: 1,
      totalEscrowed: event.args.escrowAmount,
    });
  } else {
    await context.db
      .update(launchEscrowSummary, {id: event.args.seasonId})
      .set({
        reservationCount: summary.reservationCount + 1,
        totalEscrowed: summary.totalEscrowed + event.args.escrowAmount,
      });
  }
  broadcastReservationEvent({
    type: "SLOT_RESERVED",
    seasonId: event.args.seasonId,
    creator: event.args.creator,
    amountWei: event.args.escrowAmount,
    slotIndex: event.args.slotIndex,
    tickerHash: event.args.tickerHash,
  });
});

/// Reservation post-activation: the slot's escrowAmount transferred out of the
/// escrow into the LP-creation flow. The launcher fires
/// `FilterLauncher:TokenLaunched` alongside this — the launcher handler is the
/// authoritative writer for `reservation.status = RELEASED + token`. Here we only
/// emit the SSE frame (no DB writes — the launcher handler owns those).
ponder.on("LaunchEscrow:ReservationReleased", async ({event, context}) => {
  void context;
  broadcastReservationEvent({
    type: "SLOT_RELEASED",
    seasonId: event.args.seasonId,
    creator: event.args.creator,
    amountWei: event.args.amount,
  });
});

/// Refund push succeeded. The eth is back in the creator's wallet; status flips
/// to REFUNDED. Counters: increment `totalRefunded`.
ponder.on("LaunchEscrow:ReservationRefunded", async ({event, context}) => {
  const id = `${event.args.seasonId.toString()}:${event.args.creator.toLowerCase()}`;
  const existing = await context.db.find(reservation, {id});
  if (existing) {
    await context.db
      .update(reservation, {id})
      .set({status: "REFUNDED", resolvedAt: event.block.timestamp});
  }
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  if (summary) {
    await context.db
      .update(launchEscrowSummary, {id: event.args.seasonId})
      .set({totalRefunded: summary.totalRefunded + event.args.amount});
  }
  broadcastReservationEvent({
    type: "SLOT_REFUNDED",
    seasonId: event.args.seasonId,
    creator: event.args.creator,
    amountWei: event.args.amount,
  });
});

/// Refund push failed. The escrow recorded a `pendingRefunds[seasonId][creator] = amount`
/// — the creator must call `claimPendingRefund` to drain the slot. Status flips to
/// REFUND_PENDING; a `pendingRefund` row is created.
ponder.on("LaunchEscrow:RefundFailed", async ({event, context}) => {
  const id = `${event.args.seasonId.toString()}:${event.args.creator.toLowerCase()}`;
  const existing = await context.db.find(reservation, {id});
  if (existing) {
    await context.db
      .update(reservation, {id})
      .set({status: "REFUND_PENDING", resolvedAt: event.block.timestamp});
  }
  await context.db.insert(pendingRefund).values({
    id,
    seasonId: event.args.seasonId,
    creator: event.args.creator,
    amount: event.args.amount,
    failedAt: event.block.timestamp,
    claimed: false,
  });
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  if (summary) {
    await context.db
      .update(launchEscrowSummary, {id: event.args.seasonId})
      .set({totalRefundPending: summary.totalRefundPending + event.args.amount});
  }
  broadcastReservationEvent({
    type: "SLOT_REFUND_PENDING",
    seasonId: event.args.seasonId,
    creator: event.args.creator,
    amountWei: event.args.amount,
  });
});

/// Creator (or their delegate) drained the pending-refund slot. Status flips to
/// REFUND_CLAIMED on the reservation; the `pendingRefund` row is marked claimed
/// (kept for audit history).
ponder.on("LaunchEscrow:PendingRefundClaimed", async ({event, context}) => {
  const id = `${event.args.seasonId.toString()}:${event.args.creator.toLowerCase()}`;
  const existing = await context.db.find(reservation, {id});
  if (existing) {
    await context.db
      .update(reservation, {id})
      .set({status: "REFUND_CLAIMED", resolvedAt: event.block.timestamp});
  }
  const pr = await context.db.find(pendingRefund, {id});
  if (pr) {
    await context.db
      .update(pendingRefund, {id})
      .set({claimed: true, claimedAt: event.block.timestamp});
  }
  // Move the amount out of `totalRefundPending` and into `totalRefunded` — the
  // creator is now whole; the cumulative-refund total reflects ALL successful
  // refund paths (push + claim).
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  if (summary) {
    await context.db
      .update(launchEscrowSummary, {id: event.args.seasonId})
      .set({
        totalRefundPending:
          summary.totalRefundPending > event.args.amount
            ? summary.totalRefundPending - event.args.amount
            : 0n,
        totalRefunded: summary.totalRefunded + event.args.amount,
      });
  }
  broadcastReservationEvent({
    type: "SLOT_REFUND_CLAIMED",
    seasonId: event.args.seasonId,
    creator: event.args.creator,
    amountWei: event.args.amount,
  });
});

/// Terminal abort signal from the escrow side. The launcher's `FilterLauncher:SeasonAborted`
/// already flipped `aborted=true`; this handler is the audit anchor for the per-season
/// abort summary (`reservationCount` + `totalRefunded` from the contract event itself,
/// useful for cross-checking the indexer's incremental aggregates against the contract's
/// final accounting).
ponder.on("LaunchEscrow:SeasonAborted", async ({event, context}) => {
  // Defensive — both this and the launcher signal create the row if missing.
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  if (!summary) {
    await context.db.insert(launchEscrowSummary).values({
      id: event.args.seasonId,
      aborted: true,
      abortedAt: event.block.timestamp,
    });
  }
  // Don't overwrite the incremental counters here — they're derived from the
  // per-creator events. The contract's `(reservationCount, totalRefunded)` args
  // are useful for offline reconciliation but redundant with the indexer's
  // running totals.
  broadcastSeasonStateEvent({
    type: "SEASON_ABORTED",
    seasonId: event.args.seasonId,
    reservationCount: event.args.reservationCount,
    totalRefundedWei: event.args.totalRefunded,
  });
});
