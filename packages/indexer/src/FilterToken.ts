import {ponder} from "@/generated";

import {holderBalance} from "../ponder.schema";
import {recomputeAndStampHp} from "./api/hpRecomputeWriter.js";
import {withLatencySla} from "./api/coalescing.js";
import {broadcastHpUpdated} from "./api/events/hpBroadcast.js";

/// Maintains running per-(token, holder) balances by replaying every Transfer.
///
/// Two upserts per Transfer (one for `from`, one for `to`), plus mint/burn handling:
///   - mint (from = 0x0): credit `to` only.
///   - burn (to = 0x0):   debit `from` only.
///   - transfer:          debit `from`, credit `to`.
///
/// We don't delete rows when a balance reaches zero — keeping them simplifies the
/// upsert path (no branch on "row exists?"), and the holder-snapshot writer applies
/// a dust threshold downstream so zero-balance rows are filtered out at snapshot time.
///
/// Re-entry / ordering note: Ponder processes events in (blockNumber, logIndex) order,
/// so within a single transfer chain we never see a Transfer's effect "out of sequence."
/// The balance arithmetic below is therefore safe under sequential block replay.
const ZERO = "0x0000000000000000000000000000000000000000" as const;

ponder.on("FilterToken:Transfer", async ({event, context}) => {
  const tokenAddr = event.log.address;
  const value = event.args.value;
  const ts = event.block.timestamp;

  if (value === 0n) {
    // Zero-value transfers are valid ERC-20 (some routers fire them) but a no-op for
    // balance tracking. Skip the upsert to keep the holder index churn-free.
    return;
  }

  if (event.args.from !== ZERO) {
    const fromKey = `${tokenAddr}:${event.args.from}`.toLowerCase();
    const existing = await context.db.find(holderBalance, {id: fromKey});
    const next = (existing?.balance ?? 0n) - value;
    if (existing) {
      await context.db.update(holderBalance, {id: fromKey}).set({
        balance: next,
        blockTimestamp: ts,
      });
    } else {
      // ERC-20 invariant says we shouldn't see a debit-without-credit, but if we
      // somehow boot mid-history (replay glitch, missed block) we still want a row
      // present so the next credit lands cleanly.
      await context.db.insert(holderBalance).values({
        id: fromKey,
        token: tokenAddr,
        holder: event.args.from,
        balance: next,
        blockTimestamp: ts,
        firstSeenAt: ts,
      });
    }
  }

  if (event.args.to !== ZERO) {
    const toKey = `${tokenAddr}:${event.args.to}`.toLowerCase();
    const existing = await context.db.find(holderBalance, {id: toKey});
    if (existing) {
      // Epic 1.22b — leave `firstSeenAt` untouched on subsequent credits so the
      // retention projection sees the original entry timestamp. A wallet that
      // exits to zero and later re-enters keeps the original; retention treats
      // them as a long-term holder who briefly dipped (intentional — see schema).
      await context.db.update(holderBalance, {id: toKey}).set({
        balance: existing.balance + value,
        blockTimestamp: ts,
      });
    } else {
      await context.db.insert(holderBalance).values({
        id: toKey,
        token: tokenAddr,
        holder: event.args.to,
        balance: value,
        blockTimestamp: ts,
        firstSeenAt: ts,
      });
    }
  }

  // Epic 1.17b — holder rebalancing changes the HHI input to
  // holderConcentration; recompute HP for the affected token. Per-token 1s
  // coalescing inside `recomputeAndStampHp` keeps swarms of small Transfers
  // from generating a row per event.
  await withLatencySla("holder-recompute", 3000, async () => {
    await recomputeAndStampHp(context, {
      tokenAddress: tokenAddr,
      trigger: "HOLDER_SNAPSHOT",
      blockNumber: event.block.number,
      blockTimestamp: ts,
      onWritten: broadcastHpUpdated,
    });
  });
});
