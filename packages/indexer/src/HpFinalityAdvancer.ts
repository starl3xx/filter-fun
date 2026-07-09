/// Periodic hpSnapshot finality advancer (Epic 1.22b — spec §6.12).
///
/// Block-interval handler scheduled by `ponder.config.ts`'s
/// `blocks.HpFinalityAdvancer` filter (interval env-tuned per network — see
/// `HP_FINALITY_ADVANCER_INTERVAL_BLOCKS`). On each tick, calls into
/// `runFinalityAdvancer` which promotes rows on WALL-CLOCK age (2026-07
/// Robinhood Chain retarget — Arbitrum-stack chains produce blocks on demand,
/// so block-count age is meaningless; see src/api/finalityAdvancer.ts):
///   1. Promotes `tip` rows whose `snapshotAtSec ≤ head.timestamp − SOFT_SECONDS` to `soft`.
///   2. Promotes `soft` rows whose `snapshotAtSec ≤ head.timestamp − FINAL_SECONDS` to `final`.
///
/// The full state-machine + threshold rationale lives in
/// `src/api/finalityAdvancer.ts`; this module is just the Ponder wiring.
///
/// Failure mode: if the advancer skips ticks (RPC stall, deploy gap, idle
/// chain) the transitions catch up on the next firing because the SQL filter
/// is on `snapshotAtSec ≤ cutoff`, not equality. Operator runbooks surface
/// "rows stuck at tip" as an alarm signal so a stalled advancer is detectable
/// without a separate health probe.

import {ponder} from "@/generated";

import {runFinalityAdvancer} from "./api/finalityAdvancer.js";

ponder.on("HpFinalityAdvancer:block", async ({event, context}) => {
  const result = await runFinalityAdvancer(context, event.block.timestamp);
  if (result.rowsToSoft > 0 || result.rowsToFinal > 0) {
    // One log line per tick where progress was made — silent ticks are the
    // common case (bounded by snapshot cadence). If a deploy is healthy and
    // the cohort is active we expect ~24 transitions per minute (12 tokens
    // × 2 progressions) at peak.
    console.log(
      `[finality-advancer] block=${event.block.number} ts=${event.block.timestamp} → soft=${result.rowsToSoft} final=${result.rowsToFinal}`,
    );
  }
});
