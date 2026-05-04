/// CreatorFeeDistributor event handlers.
///
/// Two concerns share this module after the Epic 1.16 / 1.21 merge:
///
///  1. Epic 1.16 (perpetual creator fees, spec §10.3 + §10.6) — fee-flow rollup.
///     The on-chain accounting is canonical (`info.accrued - info.claimed`);
///     these handlers keep an indexer-side rollup so
///     `/tokens/:address/creator-earnings` answers in O(1) instead of summing
///     every per-event `feeAccrual.toCreator` slice in the request path. Per-
///     token row is created lazily on first event observation; `creator` +
///     `seasonId` are resolved from the `token` row populated by
///     `FilterFactory.TokenDeployed`.
///
///  2. Epic 1.21 (operator admin console, spec §47.4) — audit trail.
///     `OperatorActionEmitted(actor, action, params)` is the structured audit
///     signal emitted by `disableCreatorFee`. We mirror it verbatim into
///     `operatorActionLog` — the operator console reads from that table to
///     render the audit-log view (filterable by actor / action / date range
///     per spec §47.7).

import {ponder} from "@/generated";

import {creatorEarning, operatorActionLog, token as tokenTable} from "../ponder.schema";

ponder.on("CreatorFeeDistributor:CreatorFeeAccrued", async ({event, context}) => {
  const tokenAddr = event.args.token.toLowerCase() as `0x${string}`;
  const existing = await context.db.find(creatorEarning, {token: tokenAddr});
  if (!existing) {
    const tk = await context.db.find(tokenTable, {id: tokenAddr});
    if (!tk) return;
    await context.db.insert(creatorEarning).values({
      token: tokenAddr,
      seasonId: tk.seasonId,
      creator: tk.creator,
      lifetimeAccrued: event.args.amount,
      claimed: 0n,
      redirectedToTreasury: 0n,
      lastClaimAt: null,
      disabled: false,
    });
    return;
  }
  await context.db.update(creatorEarning, {token: tokenAddr}).set({
    lifetimeAccrued: existing.lifetimeAccrued + event.args.amount,
  });
});

ponder.on("CreatorFeeDistributor:CreatorFeeClaimed", async ({event, context}) => {
  const tokenAddr = event.args.token.toLowerCase() as `0x${string}`;
  const existing = await context.db.find(creatorEarning, {token: tokenAddr});
  if (!existing) {
    // First event for this token is somehow a Claim — extremely unusual (the contract
    // requires Accrued first), but seed the row defensively so the rollup never goes
    // negative.
    const tk = await context.db.find(tokenTable, {id: tokenAddr});
    if (!tk) return;
    await context.db.insert(creatorEarning).values({
      token: tokenAddr,
      seasonId: tk.seasonId,
      creator: tk.creator,
      lifetimeAccrued: event.args.amount,
      claimed: event.args.amount,
      redirectedToTreasury: 0n,
      lastClaimAt: event.block.timestamp,
      disabled: false,
    });
    return;
  }
  await context.db.update(creatorEarning, {token: tokenAddr}).set({
    claimed: existing.claimed + event.args.amount,
    lastClaimAt: event.block.timestamp,
  });
});

ponder.on("CreatorFeeDistributor:CreatorFeeRedirected", async ({event, context}) => {
  const tokenAddr = event.args.token.toLowerCase() as `0x${string}`;
  const existing = await context.db.find(creatorEarning, {token: tokenAddr});
  if (!existing) {
    // Token disabled before any honest accrual — seed the row so the redirect tally is
    // observable from the API.
    const tk = await context.db.find(tokenTable, {id: tokenAddr});
    if (!tk) return;
    await context.db.insert(creatorEarning).values({
      token: tokenAddr,
      seasonId: tk.seasonId,
      creator: tk.creator,
      lifetimeAccrued: 0n,
      claimed: 0n,
      redirectedToTreasury: event.args.amount,
      lastClaimAt: null,
      disabled: false, // Disabled flag is set by the CreatorFeeDisabled handler, not here.
    });
    return;
  }
  await context.db.update(creatorEarning, {token: tokenAddr}).set({
    redirectedToTreasury: existing.redirectedToTreasury + event.args.amount,
  });
});

ponder.on("CreatorFeeDistributor:CreatorFeeDisabled", async ({event, context}) => {
  const tokenAddr = event.args.token.toLowerCase() as `0x${string}`;
  const existing = await context.db.find(creatorEarning, {token: tokenAddr});
  if (!existing) {
    const tk = await context.db.find(tokenTable, {id: tokenAddr});
    if (!tk) return;
    await context.db.insert(creatorEarning).values({
      token: tokenAddr,
      seasonId: tk.seasonId,
      creator: tk.creator,
      lifetimeAccrued: 0n,
      claimed: 0n,
      redirectedToTreasury: 0n,
      lastClaimAt: null,
      disabled: true,
    });
    return;
  }
  // Mirror the on-chain sweep (`info.claimed = info.accrued`) so the API's
  // `claimable = lifetimeAccrued - claimed` matches the contract's `pendingClaim`
  // (zero) for disabled tokens. The accompanying `CreatorFeeRedirected` event in
  // the same tx still bumps `redirectedToTreasury` for accounting; we only fast-
  // forward `claimed` here.
  await context.db.update(creatorEarning, {token: tokenAddr}).set({
    disabled: true,
    claimed: existing.lifetimeAccrued,
  });
});

ponder.on("CreatorFeeDistributor:OperatorActionEmitted", async ({event, context}) => {
  await context.db.insert(operatorActionLog).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    actor: event.args.actor,
    action: event.args.action,
    // The `bytes` param arrives as a 0x-prefixed hex string from viem; store as-is.
    // The operator console ABI-decodes per `action` (e.g. for "disableCreatorFee" the
    // params decode as `(address token, string reason)`).
    params: event.args.params,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});
