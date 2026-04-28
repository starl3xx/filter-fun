import {ponder} from "@/generated";
import {season, liquidation, rolloverClaim, token, vaultSeason} from "../ponder.schema";

ponder.on("SeasonVault:SettlementSubmitted", async ({event, context}) => {
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

ponder.on("SeasonVault:Finalized", async ({event, context}) => {
  const lookup = await context.db.find(vaultSeason, {vault: event.log.address});
  if (!lookup) return;
  await context.db.update(season, {id: lookup.seasonId}).set({
    totalPot: event.args.totalPot,
    rolloverWinnerTokens: event.args.rolloverWinnerTokens,
    bonusReserve: event.args.bonusReserve,
    finalizedAt: event.block.timestamp,
  });
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
