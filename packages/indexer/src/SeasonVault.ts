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
    // Epic 1.16 (spec §9.4): mirror the on-chain `SeasonVault.winnerSettledAt` here so
    // the `/season` response can resolve "is post-settlement fee routing in effect?" in
    // a single read. The contract sets it inside the same `submitWinner` tx that emits
    // this event, so `event.block.timestamp` is exactly what the on-chain field stores.
    winnerSettledAt: event.block.timestamp,
  });
});

/// Per-token liquidation row. Holder snapshots are NOT taken here — see
/// `FilterEventProcessed` below for the per-cut anchor.
///
/// Earlier draft snapshotted survivors on the first `Liquidated` of a season. Bugbot
/// caught the bug: `processFilterEvent` emits `Liquidated` per loser in a loop and
/// `FilterEventProcessed` once at the end. On the *first* `Liquidated`, only that one
/// token has been marked `liquidated = true`; the other 5 losers in the same batch
/// are still `liquidated = false`, so the "snapshot all non-liquidated tokens" walk
/// would include them as survivors — yielding a false `FILTER_SURVIVOR` badge to
/// holders of tokens that are about to be filtered in the same transaction.
/// `FilterEventProcessed` fires AFTER the loop completes, so by then every loser is
/// correctly marked — the snapshot only sees true survivors.
ponder.on("SeasonVault:Liquidated", async ({event, context}) => {
  const lookup = await context.db.find(vaultSeason, {vault: event.log.address});
  if (!lookup) return;
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
});

/// Holder snapshot anchor for the FIRST cut of a season (`eventIndex == 1`). Backs
/// `/profile.stats.filtersSurvived` and the `FILTER_SURVIVOR` badge ("held any
/// survivor when the cut fired").
///
/// We use `eventIndex == 1` not "first event we observe" — under genesis cadence
/// (one `processFilterEvent` per season), they're equivalent. If the soft filter
/// returns and there are multiple cuts per season, this still snapshots only the
/// first cut, which matches the spec's `filtersSurvived` semantic. Later cuts are
/// captured by their own per-(seasonId, eventIndex) holder snapshots if/when we
/// extend the schema with a richer trigger key.
///
/// Walk is bounded by the 12-launch cap (so cost is O(survivors × holders) per cut
/// event — acceptable). All non-liquidated, non-protocol tokens are now correctly
/// included; bugbot's batch-of-losers regression is fixed.
ponder.on("SeasonVault:FilterEventProcessed", async ({event, context}) => {
  if (event.args.eventIndex !== 1n) return;
  const lookup = await context.db.find(vaultSeason, {vault: event.log.address});
  if (!lookup) return;
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
