import {ponder} from "@/generated";

import {creatorLock} from "../ponder.schema";

/// Mirror every `Committed` event into `creatorLock`. Spec §38.5 / §38.7 guarantee that
/// the contract enforces monotonic non-decreasing locks (commit reverts if `lockUntil <=
/// previousUnlock`), so we can blindly upsert the latest event without checking the
/// existing row's value — the on-chain monotonicity invariant carries through.
///
/// `previousUnlock` is preserved on the row for indexer audits — useful for "this lock
/// was extended from X to Y" rendering on the admin console without a separate query
/// against historical events.
ponder.on("CreatorCommitments:Committed", async ({event, context}) => {
  const id = `${event.args.creator}:${event.args.token}`.toLowerCase();
  const existing = await context.db.find(creatorLock, {id});
  if (existing) {
    await context.db.update(creatorLock, {id}).set({
      unlockTimestamp: event.args.lockUntil,
      previousUnlock: event.args.previousUnlock,
      lastUpdatedAt: event.block.timestamp,
    });
  } else {
    await context.db.insert(creatorLock).values({
      id,
      creator: event.args.creator,
      token: event.args.token,
      unlockTimestamp: event.args.lockUntil,
      previousUnlock: event.args.previousUnlock,
      lastUpdatedAt: event.block.timestamp,
    });
  }
});
