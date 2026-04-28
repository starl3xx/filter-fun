import {ponder} from "@/generated";
import {bonusFunding, bonusClaim} from "../ponder.schema";

ponder.on("BonusDistributor:BonusFunded", async ({event, context}) => {
  await context.db.insert(bonusFunding).values({
    id: event.args.seasonId,
    vault: event.args.vault,
    winnerToken: "0x0000000000000000000000000000000000000000", // not in event; can backfill
    reserve: event.args.reserve,
    unlockTime: event.args.unlockTime,
  });
});

ponder.on("BonusDistributor:BonusRootPosted", async ({event, context}) => {
  await context.db
    .update(bonusFunding, {id: event.args.seasonId})
    .set({rootPosted: true});
});

ponder.on("BonusDistributor:BonusClaimed", async ({event, context}) => {
  await context.db.insert(bonusClaim).values({
    id: `${event.args.seasonId.toString()}:${event.args.user}`,
    seasonId: event.args.seasonId,
    user: event.args.user,
    amount: event.args.amount,
    blockTimestamp: event.block.timestamp,
  });
});
