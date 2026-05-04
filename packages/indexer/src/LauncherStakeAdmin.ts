/// LauncherStakeAdmin event handlers — Epic 1.15a soft-filter / activation accounting.
///
/// Post-activation lifecycle: once a season activates, slots that previously RELEASED
/// can transition to either FORFEITED (creator's token failed soft-filter) or REFUNDED
/// (creator's token survived soft-filter, stake returned). Both events fire by token
/// address, but the underlying reservation is keyed by `(seasonId, creator)` — so we
/// resolve by reading the launched `token` row's creator first.

import {ponder} from "@/generated";

import {broadcastReservationEvent} from "./api/events/launchBroadcast.js";
import {launchEscrowSummary, reservation, token} from "../ponder.schema";

/// Stake survived soft-filter — refunded to creator. Reservation transitions
/// RELEASED → REFUNDED (note: the reservation was already RELEASED via the
/// FilterLauncher.TokenLaunched handler when the slot normalized; this is the
/// post-launch refund of the *stake*, distinct from the pre-activation escrow refund).
ponder.on("LauncherStakeAdmin:StakeRefunded", async ({event, context}) => {
  const tokenRow = await context.db.find(token, {id: event.args.token});
  if (!tokenRow) return;
  const id = `${event.args.seasonId.toString()}:${tokenRow.creator.toLowerCase()}`;
  const existing = await context.db.find(reservation, {id});
  if (!existing) return;
  await context.db
    .update(reservation, {id})
    .set({status: "REFUNDED", resolvedAt: event.block.timestamp});
  // Don't touch `launchEscrowSummary.totalRefunded` here — that counter tracks the
  // pre-activation escrow refunds (creator's slot creation cost). The post-activation
  // stake refund is a separate accounting flow handled by `LauncherStakeAdmin` itself,
  // not the escrow contract's totals. The reservation row's `status` is the canonical
  // surface for "did this slot end up refunded?" regardless of which path got it there.
  void event;
});

/// Stake forfeited — soft-filter cut, creator loses the stake to `forfeitRecipient`.
/// Reservation transitions to FORFEITED. The token row's `liquidated` flag is set
/// elsewhere (FilterFactory / SeasonVault liquidation handler).
ponder.on("LauncherStakeAdmin:StakeForfeited", async ({event, context}) => {
  const tokenRow = await context.db.find(token, {id: event.args.token});
  if (!tokenRow) return;
  const id = `${event.args.seasonId.toString()}:${tokenRow.creator.toLowerCase()}`;
  const existing = await context.db.find(reservation, {id});
  if (!existing) return;
  await context.db
    .update(reservation, {id})
    .set({status: "FORFEITED", resolvedAt: event.block.timestamp});
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  if (summary) {
    await context.db
      .update(launchEscrowSummary, {id: event.args.seasonId})
      .set({totalForfeited: summary.totalForfeited + event.args.amount});
  }
  broadcastReservationEvent({
    type: "SLOT_FORFEITED",
    seasonId: event.args.seasonId,
    creator: tokenRow.creator,
    amountWei: event.args.amount,
    token: event.args.token,
  });
});
