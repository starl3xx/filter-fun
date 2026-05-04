import {ponder} from "@/generated";

import {creatorEarning, token as tokenTable} from "../ponder.schema";

/// Singleton CreatorFeeDistributor handlers (Epic 1.16, spec §10.3 + §10.6).
///
/// The on-chain accounting is canonical (`info.accrued - info.claimed`); these handlers
/// keep an indexer-side rollup so `/tokens/:address/creator-earnings` answers in O(1)
/// instead of summing every per-event `feeAccrual.toCreator` slice in the request path.
///
/// Per-token row is created lazily on first event observation. We resolve `creator` +
/// `seasonId` from the existing `token` row populated by `FilterFactory.TokenDeployed` —
/// the singleton always emits its first creator-fee event AFTER the launcher has
/// registered the token, so the lookup is always non-null when this fires.

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
  await context.db.update(creatorEarning, {token: tokenAddr}).set({disabled: true});
});
