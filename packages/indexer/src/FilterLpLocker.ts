import {ponder} from "@/generated";
import {feeAccrual} from "../ponder.schema";

/// `FilterLpLocker.collectFees()` emits `FeesCollected` (pre-settlement, spec §9.2) or
/// `PostSettlementFeesCollected` (post-settlement, spec §9.4 — Epic 1.16) once per asset
/// per invocation. Both events are persisted into the same `feeAccrual` table; the
/// `routing` discriminator distinguishes the destination of `toVault` (SeasonVault when
/// PRE_SETTLEMENT, POLVault when POST_SETTLEMENT). Field name preserved for backwards
/// compat with /tokens consumers that pre-date Epic 1.16; new readers should switch on
/// `routing` to attribute per-event POL exposure correctly.
ponder.on("FilterLpLocker:FeesCollected", async ({event, context}) => {
  await context.db.insert(feeAccrual).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    token: event.log.address, // the locker's address; client maps locker → token
    asset: event.args.asset,
    routing: "PRE_SETTLEMENT",
    toVault: event.args.toVault,
    toTreasury: event.args.toTreasury,
    toMechanics: event.args.toMechanics,
    toCreator: event.args.toCreator,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("FilterLpLocker:PostSettlementFeesCollected", async ({event, context}) => {
  await context.db.insert(feeAccrual).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    token: event.log.address,
    asset: event.args.asset,
    routing: "POST_SETTLEMENT",
    // `toVault` here is the POL slice — the locker has already routed the WETH to the
    // singleton POLVault. Naming-wise this is the "destination of the prize-pool slice",
    // which is what the field semantically encodes across both routing regimes.
    toVault: event.args.toPolVault,
    toTreasury: event.args.toTreasury,
    toMechanics: event.args.toMechanics,
    toCreator: event.args.toCreator,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});
