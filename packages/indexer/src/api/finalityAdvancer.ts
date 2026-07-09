/// hpSnapshot finality advancer — Epic 1.22b (spec §6.12), re-based to wall-clock
/// seconds for the 2026-07 Robinhood Chain retarget.
///
/// Periodic block-tick handler that progresses non-settlement rows along the
/// reorg-safety state machine:
///
///   tip   — written at the head, may still reorg
///   soft  — ≥ FINALITY_SOFT_SECONDS past write, statistically safe
///   final — ≥ FINALITY_FINAL_SECONDS past write, considered final
///
/// WHY SECONDS, NOT BLOCKS. The original thresholds (6/12 blocks) assumed Base's
/// fixed 2s cadence (12s/24s wall-clock). Robinhood Chain is Arbitrum-stack:
/// blocks are produced on demand — ~0.10s apart under load (measured 2026-07-09),
/// arbitrarily far apart when idle. A block-count threshold is therefore wrong in
/// BOTH directions: 12 blocks ≈ 1.2s of protection under load (near-zero buffer)
/// and potentially hours of stalled promotion when idle. Wall-clock is the only
/// stable unit; the chain's reorg model (single sequencer, feed-level soft
/// finality, reorg only on sequencer crash-replay or L1 reorg) is time-shaped,
/// not block-shaped. Rows compare on `snapshotAtSec` (the write-time BLOCK
/// timestamp — deterministic and reorg-consistent, not indexer wall-clock).
///
/// CUT and FINALIZE rows write as `final` by construction (see
/// `initialFinalityForTrigger` in hpRecompute.ts), so they never match the
/// advancer's filter — there's no risk of double-stamping.
///
/// Design notes:
///   - Two SQL UPDATEs per tick (tip→soft, soft→final). PostgreSQL handles
///     both as small bounded updates against an indexed `(finality, snapshotAtSec)`
///     pair; no row-level locking concerns since the writer only INSERTs rows
///     with `finality = 'tip'` and the advancer only UPDATEs rows whose
///     `snapshotAtSec` has aged out — they don't race.
///   - We do NOT advance rows where `finality = 'final'` (idempotent floor)
///     and we never demote (`tip` → no, `soft` → tip is impossible). The
///     advancer is monotonic in the finality lattice.
///   - The advancer runs cohort-wide, not per-token. There's no benefit to
///     scoping by token — the timestamp filter is the same regardless.
///   - IDLE-CHAIN CAVEAT: the advancer only runs on block ticks, so with zero
///     chain activity promotion stalls at the last tick. Harmless for the data
///     (age is computed from block timestamps when the next tick fires) but the
///     testnet rehearsal runs a heartbeat tx (see ops runbook) so ticks — and
///     therefore promotions — keep firing on an otherwise-quiet chain.
///
/// **Reorg-aware caveat (deferred).** A real reorg deeper than
/// FINALITY_SOFT_SECONDS but shallower than FINALITY_FINAL_SECONDS would
/// invalidate `soft` rows. Ponder doesn't expose a "reorg detected" hook in
/// the block-tick handler API, so we pin conservative thresholds and accept
/// that a deep-reorg incident triggers a manual re-index. The settlement
/// contract reads only `final` rows, so a reorg inside the `[soft, final)`
/// window doesn't put settlement at risk; only the observability surface
/// (web UI + API) might briefly show stale tip data, which is recoverable on
/// next tick.

import {and, eq, lte} from "@ponder/core";

import {hpSnapshot} from "../../ponder.schema";

/// Wall-clock thresholds for finality progression, in seconds. Genesis defaults:
/// soft at 30s, final at 120s — strictly MORE conservative in wall-clock terms
/// than the old Base setting (12s/24s) while staying inside game UX. True L1
/// finality (~15–20 min) is not required: the Base thresholds never provided it
/// either, and settlement provenance rides on the oracle's own final-only reads.
/// Env-overridable per network (`HP_FINALITY_SOFT_SECONDS` /
/// `HP_FINALITY_FINAL_SECONDS`) so ops can retune without a deploy.
function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.warn(`[finality] ignoring non-integer ${name}=${raw}; using ${fallback}`);
    return fallback;
  }
  return BigInt(parsed);
}

export const FINALITY_SOFT_SECONDS = envBigInt("HP_FINALITY_SOFT_SECONDS", 30n);
export const FINALITY_FINAL_SECONDS = envBigInt("HP_FINALITY_FINAL_SECONDS", 120n);

export type HpFinality = "tip" | "soft" | "final";

/// Pure helper exposed for tests: given the current head block TIMESTAMP (sec),
/// returns the threshold timestamps at-or-below which a row is eligible for
/// each transition. A row at `snapshotAtSec ≤ softCutoff` graduates to `soft`;
/// at `snapshotAtSec ≤ finalCutoff` graduates to `final`.
export function finalityCutoffs(currentTimestampSec: bigint): {
  softCutoff: bigint;
  finalCutoff: bigint;
} {
  return {
    softCutoff: currentTimestampSec - FINALITY_SOFT_SECONDS,
    finalCutoff: currentTimestampSec - FINALITY_FINAL_SECONDS,
  };
}

/// Pure helper: given a row's current finality + write timestamp and the head
/// block timestamp, returns the next finality value (or null if no transition
/// is needed). Tests pin the truth table; production calls the SQL path
/// below for batch updates.
export function nextFinality(
  current: HpFinality,
  rowSnapshotAtSec: bigint,
  currentTimestampSec: bigint,
): HpFinality | null {
  if (current === "final") return null;
  const {softCutoff, finalCutoff} = finalityCutoffs(currentTimestampSec);
  if (current === "tip") {
    if (rowSnapshotAtSec <= finalCutoff) return "final";
    if (rowSnapshotAtSec <= softCutoff) return "soft";
    return null;
  }
  // current === "soft"
  if (rowSnapshotAtSec <= finalCutoff) return "final";
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
  currentTimestampSec: bigint,
): Promise<{rowsToSoft: number; rowsToFinal: number}> {
  const {softCutoff, finalCutoff} = finalityCutoffs(currentTimestampSec);

  // tip → soft. We use `<=` against the cutoff so a row that's been at the
  // tip for exactly FINALITY_SOFT_SECONDS graduates this tick. The row set is
  // small and bounded (cohort × snapshot cadence), same as the block-count era.
  //
  // Drizzle's update() returns no count by default in Ponder's surface; we
  // do a select-then-update so the test path can assert against counts.
  const tipRows = await context.db.sql
    .select()
    .from(hpSnapshot)
    .where(and(eq(hpSnapshot.finality, "tip"), lte(hpSnapshot.snapshotAtSec, softCutoff)));

  let rowsToSoft = 0;
  let rowsToFinal = 0;
  for (const row of tipRows as Array<{id: string; snapshotAtSec: bigint}>) {
    if (row.snapshotAtSec <= finalCutoff) {
      // Skip the soft step entirely if the row is already past the final
      // threshold — the advancer hasn't run in a while (idle chain) or this
      // row was backfilled stale. One-step transition is correct.
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
    .where(and(eq(hpSnapshot.finality, "soft"), lte(hpSnapshot.snapshotAtSec, finalCutoff)));
  for (const row of softRows as Array<{id: string}>) {
    await context.db.update(hpSnapshot, {id: row.id}).set({finality: "final"});
    rowsToFinal++;
  }

  return {rowsToSoft, rowsToFinal};
}
