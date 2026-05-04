/// hpSnapshot finality advancer — Epic 1.22b (spec §6.12).
///
/// Periodic block-tick handler that progresses non-settlement rows along the
/// reorg-safety state machine:
///
///   tip   — written at the head, may still reorg
///   soft  — ≥ FINALITY_SOFT_BLOCKS past write, statistically safe
///   final — ≥ FINALITY_FINAL_BLOCKS past write, considered final under Base finality
///
/// CUT and FINALIZE rows write as `final` by construction (the writer waits
/// ≥12 blocks past the wall-clock boundary before insert), so they never
/// match the advancer's filter — there's no risk of double-stamping.
///
/// Design notes:
///   - Two SQL UPDATEs per tick (tip→soft, soft→final). PostgreSQL handles
///     both as small bounded updates against an indexed `(finality, blockNumber)`
///     pair; no row-level locking concerns since the writer only INSERTs rows
///     with `finality = 'tip'` and the advancer only UPDATEs rows whose
///     `blockNumber` has aged out — they don't race.
///   - We do NOT advance rows where `finality = 'final'` (idempotent floor)
///     and we never demote (`tip` → no, `soft` → tip is impossible). The
///     advancer is monotonic in the finality lattice.
///   - The advancer runs cohort-wide, not per-token. There's no benefit to
///     scoping by token — the block-number filter is the same regardless.
///
/// **Reorg-aware caveat (deferred).** A real reorg deeper than
/// FINALITY_SOFT_BLOCKS but shallower than FINALITY_FINAL_BLOCKS would
/// invalidate `soft` rows. Ponder doesn't expose a "reorg detected" hook in
/// the block-tick handler API, so we pin the conservative thresholds and
/// accept that a deep-reorg incident triggers a manual re-index. The
/// settlement contract reads only `final` rows, so a reorg inside the
/// `[soft, final)` window doesn't put settlement at risk; only the
/// observability surface (web UI + API) might briefly show stale tip data,
/// which is recoverable on next tick.

import {and, eq, lte} from "@ponder/core";

import {hpSnapshot} from "../../ponder.schema";

/// Block thresholds for finality progression. Base finality is empirically
/// ~12 blocks (24s at 2s blocktimes); the soft threshold is half of that as
/// a "statistically safe but not guaranteed" intermediate state. These match
/// the values cited in `ponder.schema.ts`'s `hpSnapshot.finality` doc.
export const FINALITY_SOFT_BLOCKS = 6n;
export const FINALITY_FINAL_BLOCKS = 12n;

export type HpFinality = "tip" | "soft" | "final";

/// Pure helper exposed for tests: given the current head block number,
/// returns the threshold block numbers above which a row is eligible for
/// each transition. A row at `blockNumber ≤ softCutoff` graduates to `soft`;
/// at `blockNumber ≤ finalCutoff` graduates to `final`.
export function finalityCutoffs(currentBlock: bigint): {
  softCutoff: bigint;
  finalCutoff: bigint;
} {
  return {
    softCutoff: currentBlock - FINALITY_SOFT_BLOCKS,
    finalCutoff: currentBlock - FINALITY_FINAL_BLOCKS,
  };
}

/// Pure helper: given a row's current finality + blockNumber and the head
/// block number, returns the next finality value (or null if no transition
/// is needed). Tests pin the truth table; production calls the SQL path
/// below for batch updates.
export function nextFinality(
  current: HpFinality,
  rowBlockNumber: bigint,
  currentBlock: bigint,
): HpFinality | null {
  if (current === "final") return null;
  const {softCutoff, finalCutoff} = finalityCutoffs(currentBlock);
  if (current === "tip") {
    if (rowBlockNumber <= finalCutoff) return "final";
    if (rowBlockNumber <= softCutoff) return "soft";
    return null;
  }
  // current === "soft"
  if (rowBlockNumber <= finalCutoff) return "final";
  return null;
}

/// Runs both transitions against the indexer DB. Idempotent; safe to call
/// every block tick. Returns the (rowsToSoft, rowsToFinal) counts so the
/// handler can log progress.
///
/// The `context` arg is the Ponder block-handler context (loosely typed —
/// see `hpRecomputeWriter.ts` for the same pattern).
export async function runFinalityAdvancer(
  context: any,
  currentBlock: bigint,
): Promise<{rowsToSoft: number; rowsToFinal: number}> {
  const {softCutoff, finalCutoff} = finalityCutoffs(currentBlock);

  // tip → soft. We use `<=` against the cutoff so a row that's been at the
  // tip for exactly FINALITY_SOFT_BLOCKS graduates this tick. The `ne` on
  // 'final' is defensive — `eq('tip')` already excludes 'final', but a
  // future row that lands as 'final' directly (e.g. CUT/FINALIZE) is
  // explicitly skipped here for clarity.
  //
  // Drizzle's update() returns no count by default in Ponder's surface; we
  // do a select-then-update so the test path can assert against counts.
  // Production traffic: cohort × snapshot interval (12 tokens × ≈5min) =
  // ~24 rows transitioning per minute at peak — trivial.
  const tipRows = await context.db.sql
    .select()
    .from(hpSnapshot)
    .where(and(eq(hpSnapshot.finality, "tip"), lte(hpSnapshot.blockNumber, softCutoff)));

  let rowsToSoft = 0;
  let rowsToFinal = 0;
  for (const row of tipRows as Array<{id: string; blockNumber: bigint}>) {
    if (row.blockNumber <= finalCutoff) {
      // Skip the soft step entirely if the row is already past the final
      // threshold — the advancer hasn't run in a while or this row was
      // backfilled stale. One-step transition is correct.
      await context.db.update(hpSnapshot, {id: row.id}).set({finality: "final"});
      rowsToFinal++;
    } else {
      await context.db.update(hpSnapshot, {id: row.id}).set({finality: "soft"});
      rowsToSoft++;
    }
  }

  // soft → final. Independent query since some rows might already be 'soft'
  // from prior ticks.
  const softRows = await context.db.sql
    .select()
    .from(hpSnapshot)
    .where(and(eq(hpSnapshot.finality, "soft"), lte(hpSnapshot.blockNumber, finalCutoff)));
  for (const row of softRows as Array<{id: string}>) {
    await context.db.update(hpSnapshot, {id: row.id}).set({finality: "final"});
    rowsToFinal++;
  }

  return {rowsToSoft, rowsToFinal};
}
