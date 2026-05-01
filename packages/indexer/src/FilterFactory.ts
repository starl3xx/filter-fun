import {ponder} from "@/generated";

import {pool} from "../ponder.schema";

/// Capture the (poolId → token) map at every launch. The V4PoolManager handler joins
/// `Swap.id` against this table to translate a chain-wide Swap event back to one of our
/// FilterToken pools — without it, every swap row would be either anonymous or require
/// a where-clause query against `pool` for each event (slow path on Postgres at chain
/// scale). The factory pattern in `ponder.config.ts` already reads this same event for
/// `FilterLpLocker` + `FilterToken` registration; this handler just persists the
/// poolId field too.
ponder.on("FilterFactory:TokenDeployed", async ({event, context}) => {
  await context.db.insert(pool).values({
    id: event.args.poolId as `0x${string}`,
    token: event.args.token,
    locker: event.args.locker,
    creator: event.args.creator,
  });
});
