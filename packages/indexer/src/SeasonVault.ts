import {ponder} from "@/generated";
import {and, eq} from "@ponder/core";

import {
  holderBalance,
  holderSnapshot,
  liquidation,
  rolloverClaim,
  season,
  token,
  vaultSeason,
} from "../ponder.schema";

import {DUST_BALANCE_THRESHOLD} from "./holders.js";

/// `WinnerSubmitted` (formerly `SettlementSubmitted` in pre-Epic-1.6 contracts) carries
/// the season's winner address + the rollover Merkle root + the total rollover shares.
/// We mirror those into `season` so /season + /profile can resolve "is my token the
/// winner?" from a primary-key lookup.
ponder.on("SeasonVault:WinnerSubmitted", async ({event, context}) => {
  const lookup = await context.db.find(vaultSeason, {vault: event.log.address});
  if (!lookup) return;
  await context.db.update(season, {id: lookup.seasonId}).set({
    winner: event.args.winner,
    rolloverRoot: event.args.rolloverRoot,
    totalRolloverShares: event.args.totalRolloverShares,
  });
});

ponder.on("SeasonVault:Liquidated", async ({event, context}) => {
  const lookup = await context.db.find(vaultSeason, {vault: event.log.address});
  if (!lookup) return;

  // Detect first cut BEFORE inserting our row. `priorCuts` here is "rows already in
  // the table for this season" — strictly less than the current event count.
  const priorCuts = await context.db.sql
    .select()
    .from(liquidation)
    .where(eq(liquidation.seasonId, lookup.seasonId));
  const isFirstCut = priorCuts.length === 0;

  await context.db.insert(liquidation).values({
    id: `${lookup.seasonId.toString()}:${event.args.token}`,
    seasonId: lookup.seasonId,
    token: event.args.token,
    wethOut: event.args.wethOut,
    blockTimestamp: event.block.timestamp,
  });
  await context.db.update(token, {id: event.args.token}).set({
    liquidated: true,
    liquidationProceeds: event.args.wethOut,
  });

  // Holder snapshot anchor: the first `Liquidated` event of a season is the "first
  // cut" we use to compute filtersSurvived + the FILTER_SURVIVOR badge. Walk every
  // still-active, non-protocol token in the season and snapshot its holders. The
  // walk is bounded by the 12-launch cap, so cost is O(survivors × holders) per
  // first-cut event — acceptable.
  if (isFirstCut) {
    const survivors = await context.db.sql
      .select()
      .from(token)
      .where(
        and(
          eq(token.seasonId, lookup.seasonId),
          eq(token.liquidated, false),
          eq(token.isProtocolLaunched, false),
        ),
      );
    for (const tk of survivors) {
      const balances = await context.db.sql
        .select()
        .from(holderBalance)
        .where(eq(holderBalance.token, tk.id));
      for (const b of balances) {
        if (b.balance < DUST_BALANCE_THRESHOLD) continue;
        await context.db.insert(holderSnapshot).values({
          id: `${lookup.seasonId.toString()}:CUT:${b.token}:${b.holder}`.toLowerCase(),
          seasonId: lookup.seasonId,
          trigger: "CUT",
          token: b.token,
          holder: b.holder,
          balance: b.balance,
          blockTimestamp: event.block.timestamp,
        });
      }
    }
  }
});

/// `Finalized` (post-Epic-1.6 V4 vault) emits the per-slice settlement amounts:
/// `rolloverWethConsumed`, `rolloverWinnerTokens`, `bonusFunded`, `polDeployedWeth`,
/// `polDeployedTokens`, `tradingFeeSweptToTreasury`. The legacy schema fields
/// (`totalPot`, `bonusReserve`) are mapped on insert:
///
///   `totalPot` ← rolloverWethConsumed + bonusFunded + polDeployedWeth + tradingFeeSweptToTreasury
///   `bonusReserve` ← bonusFunded
///
/// This preserves /season's `championPool = totalPot - bonusReserve` formula at the
/// expected semantic (winner-side WETH, excluding the hold-bonus subset).
ponder.on("SeasonVault:Finalized", async ({event, context}) => {
  const lookup = await context.db.find(vaultSeason, {vault: event.log.address});
  if (!lookup) return;
  const totalPot =
    event.args.rolloverWethConsumed +
    event.args.bonusFunded +
    event.args.polDeployedWeth +
    event.args.tradingFeeSweptToTreasury;
  await context.db.update(season, {id: lookup.seasonId}).set({
    totalPot,
    rolloverWinnerTokens: event.args.rolloverWinnerTokens,
    bonusReserve: event.args.bonusFunded,
    finalizedAt: event.block.timestamp,
  });

  // Snapshot the winner's holders at finalize. A wallet that holds the winner here
  // earns the WEEK_WINNER badge; the snapshot makes this derivable from /profile
  // without a per-request balance query against historical state.
  const seasonRow = await context.db.find(season, {id: lookup.seasonId});
  if (!seasonRow?.winner) return;
  const winner = seasonRow.winner;
  const balances = await context.db.sql
    .select()
    .from(holderBalance)
    .where(eq(holderBalance.token, winner));
  for (const b of balances) {
    if (b.balance < DUST_BALANCE_THRESHOLD) continue;
    await context.db.insert(holderSnapshot).values({
      id: `${lookup.seasonId.toString()}:FINALIZE:${b.token}:${b.holder}`.toLowerCase(),
      seasonId: lookup.seasonId,
      trigger: "FINALIZE",
      token: b.token,
      holder: b.holder,
      balance: b.balance,
      blockTimestamp: event.block.timestamp,
    });
  }
});

ponder.on("SeasonVault:RolloverClaimed", async ({event, context}) => {
  const lookup = await context.db.find(vaultSeason, {vault: event.log.address});
  if (!lookup) return;
  await context.db.insert(rolloverClaim).values({
    id: `${lookup.seasonId.toString()}:${event.args.user}`,
    seasonId: lookup.seasonId,
    user: event.args.user,
    share: event.args.share,
    winnerTokens: event.args.winnerTokens,
    blockTimestamp: event.block.timestamp,
  });
});
