/// CreatorFeeDistributor event handlers (Epic 1.21 / spec §47.4).
///
/// Only `OperatorActionEmitted` is consumed today — the fee-accrual events
/// (`CreatorFeeAccrued` / `CreatorFeeRedirected` / `CreatorFeeClaimed`) don't yet
/// have a UI surface and are intentionally not indexed to keep the schema lean.
/// When the operator console grows a per-creator fee-flow view, those handlers
/// land here.
///
/// `OperatorActionEmitted(actor, action, params)` is the structured audit signal
/// emitted by `disableCreatorFee`. We mirror it verbatim into `operatorActionLog`
/// — the operator console reads from that table to render the audit-log view
/// (filterable by actor / action / date range per spec §47.7).

import {ponder} from "@/generated";

import {operatorActionLog} from "../ponder.schema";

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
