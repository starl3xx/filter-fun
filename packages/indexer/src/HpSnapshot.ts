/// Periodic HP snapshot writer. Block-interval handler scheduled by `ponder.config.ts`'s
/// `blocks.HpSnapshot` filter (default every 150 blocks ≈ 5 min on Base). On each tick:
///
///   1. Resolve the current season + cohort via the same query shapes used by /season
///      and /tokens. (We don't share code with the API tick engine because that's
///      HTTP-side periodic; this is on-chain block-driven and the schemas of "what HP
///      means *now*" must agree on a single source of truth — `scoreCohort`.)
///   2. Run `scoreCohort` to derive HP + 5 components per token under phase weights.
///   3. Write one `hpSnapshot` row per token. The endpoint reads these rows back and
///      buckets/decimates per the user's interval query param.
///
/// We intentionally key snapshots by `(token, snapshotAtSec)` (not block number) so the
/// timeseries reads cleanly even when block cadence shifts. `snapshotAtSec` is the block
/// timestamp of the firing block — Ponder doesn't expose wall-clock here.

import {ponder} from "@/generated";
import {desc, eq} from "@ponder/core";

import {hpSnapshot, season, token} from "../ponder.schema";

import {hpAsInt100} from "./api/builders.js";
import {scoreCohort} from "./api/hp.js";
import {toApiPhase} from "./api/phase.js";

ponder.on("HpSnapshot:block", async ({event, context}) => {
  // Resolve "current season" exactly the way the API does — highest seasonId in `season`.
  // No season ⇒ nothing to snapshot. (Indexer just started; no token launches yet.)
  const seasonRows = await context.db.sql
    .select()
    .from(season)
    .orderBy(desc(season.id))
    .limit(1);
  const seasonRow = seasonRows[0];
  if (!seasonRow) return;

  const tokens = await context.db.sql
    .select()
    .from(token)
    .where(eq(token.seasonId, seasonRow.id));
  if (tokens.length === 0) return;

  const apiPhase = toApiPhase(seasonRow.phase);
  const scored = scoreCohort(
    tokens.map((t) => ({id: t.id, liquidationProceeds: t.liquidationProceeds})),
    apiPhase,
    event.block.timestamp,
  );

  for (const t of tokens) {
    const s = scored.get(t.id.toLowerCase());
    if (!s) continue;
    await context.db.insert(hpSnapshot).values({
      id: `${t.id}:${event.block.timestamp.toString()}`.toLowerCase(),
      token: t.id,
      snapshotAtSec: event.block.timestamp,
      hp: hpAsInt100(s.hp),
      rank: s.rank,
      velocity: s.components.velocity.score,
      effectiveBuyers: s.components.effectiveBuyers.score,
      stickyLiquidity: s.components.stickyLiquidity.score,
      retention: s.components.retention.score,
      momentum: s.components.momentum.score,
      phase: apiPhase,
      blockNumber: event.block.number,
    });
  }
});
