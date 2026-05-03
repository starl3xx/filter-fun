/// Periodic HP snapshot writer. Block-interval handler scheduled by `ponder.config.ts`'s
/// `blocks.HpSnapshot` filter (default every 150 blocks ≈ 5 min on Base). On each tick:
///
///   1. Resolve the current season + cohort via the same query shapes used by /season
///      and /tokens.
///   2. Run `scoreCohort` to derive HP + components per token under the v4-locked weights.
///   3. Write one `hpSnapshot` row per token, tagged `trigger = "BLOCK_TICK"`.
///
/// **Epic 1.17b refactor.** This handler now delegates to `recomputeAndStampHp`
/// from `api/hpRecomputeWriter.ts`. The same primitive serves swap-driven,
/// holder-driven, and scheduler-driven recomputes — keeping a single source
/// of truth for "how to write an hpSnapshot row." `BLOCK_TICK` is the
/// cohort-wide periodic floor; coalescing logic only applies to per-token
/// triggers (SWAP, HOLDER_SNAPSHOT) and is a no-op here.

import {ponder} from "@/generated";

import {recomputeAndStampHp} from "./api/hpRecomputeWriter.js";

ponder.on("HpSnapshot:block", async ({event, context}) => {
  await recomputeAndStampHp(context, {
    // Cohort-wide trigger ignores the tokenAddress; pass a zero placeholder.
    tokenAddress: "0x0000000000000000000000000000000000000000",
    trigger: "BLOCK_TICK",
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});
