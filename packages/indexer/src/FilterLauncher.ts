import {ponder} from "@/generated";
import {season, token, phaseChange, vaultSeason} from "../ponder.schema";

const PHASE_NAMES = ["Launch", "Filter", "Finals", "Settlement", "Closed"] as const;

ponder.on("FilterLauncher:SeasonStarted", async ({event, context}) => {
  await context.db.insert(season).values({
    id: event.args.seasonId,
    startedAt: event.block.timestamp,
    vault: event.args.vault,
    phase: "Launch",
  });
  await context.db.insert(vaultSeason).values({
    vault: event.args.vault,
    seasonId: event.args.seasonId,
  });
});

ponder.on("FilterLauncher:TokenLaunched", async ({event, context}) => {
  await context.db.insert(token).values({
    id: event.args.token,
    seasonId: event.args.seasonId,
    symbol: event.args.symbol,
    name: event.args.name,
    metadataUri: event.args.metadataURI,
    creator: event.args.creator,
    locker: event.args.locker,
    isProtocolLaunched: event.args.isProtocolLaunched,
    createdAt: event.block.timestamp,
  });
});

ponder.on("FilterLauncher:PhaseAdvanced", async ({event, context}) => {
  const newPhase = PHASE_NAMES[Number(event.args.newPhase)] ?? "Unknown";
  await context.db
    .update(season, {id: event.args.seasonId})
    .set({phase: newPhase});
  await context.db.insert(phaseChange).values({
    id: `${event.args.seasonId.toString()}:${event.log.logIndex}`,
    seasonId: event.args.seasonId,
    newPhase,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("FilterLauncher:FinalistsSet", async ({event, context}) => {
  for (const finalistAddr of event.args.finalists) {
    await context.db
      .update(token, {id: finalistAddr})
      .set({isFinalist: true});
  }
});
