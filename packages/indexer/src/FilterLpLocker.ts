import {ponder} from "@/generated";
import {feeAccrual} from "../ponder.schema";

/// Each `FilterLpLocker.collectFees()` invocation can emit `FeesCollected` once per asset.
/// We record each emission with full breakdown for downstream scoring + analytics.
ponder.on("FilterLpLocker:FeesCollected", async ({event, context}) => {
  await context.db.insert(feeAccrual).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    token: event.log.address, // the locker's address; client maps locker → token
    asset: event.args.asset,
    toVault: event.args.toVault,
    toTreasury: event.args.toTreasury,
    toMechanics: event.args.toMechanics,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});
