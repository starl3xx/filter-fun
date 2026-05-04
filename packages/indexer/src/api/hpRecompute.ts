/// HP recompute primitive — Epic 1.17b compute pathway.
///
/// One entry point used by every event-driven recompute trigger:
///   - `SWAP`            — V4PoolManager Swap event handler
///   - `HOLDER_SNAPSHOT` — FilterToken Transfer event handler
///   - `PHASE_BOUNDARY`  — scheduler at h0/24/48/72/96/168
///   - `CUT`             — scheduler at h96 ± 10s tolerance window
///   - `FINALIZE`        — scheduler at h168
///   - `BLOCK_TICK`      — periodic block-interval handler (legacy, kept for cadence floor)
///
/// **What this module is.** A composition layer: takes a cohort + active
/// season + the trigger that fired the recompute, runs `scoreCohort`, writes
/// one `hpSnapshot` row per affected token (or all tokens for cohort-wide
/// triggers), and pushes one `HP_UPDATED` SSE event per write through the
/// shared hub.
///
/// **What this module is NOT.** It does not own coalescing — the swap handler
/// owns that (per-token 1s debounce via `coalescing.ts`). It does not own
/// scheduling — the scheduler module owns phase-boundary firings. It does
/// not own oracle Merkle publication — `packages/oracle/src/settlement.ts`
/// reads CUT/FINALIZE rows and posts the root.
///
/// Pure helpers (`buildHpUpdatedEvent`, `selectTokenForRecompute`) live here
/// for testability; the impure DB+SSE writer lives below them.

import type {ScoredToken} from "@filter-fun/scoring";

import type {TickerEvent} from "./events/types.js";

/// Closed set of trigger labels stamped onto every hpSnapshot row.
export type HpRecomputeTrigger =
  | "BLOCK_TICK"
  | "SWAP"
  | "HOLDER_SNAPSHOT"
  | "PHASE_BOUNDARY"
  | "CUT"
  | "FINALIZE";

/// Wire-shape of the HP_UPDATED SSE event's `data` payload (per dispatch).
export interface HpUpdatedData {
  /// Integer in `[HP_MIN, HP_MAX]` (= [0, 10000]) — Epic 1.18 composite scale,
  /// matches the wire format of /tokens.hp + hpSnapshot.hp. Pre-1.18 the wire
  /// shape was 0-100 integer; the SSE payload type didn't change but the
  /// value range did. Clients that gate on absolute thresholds must be
  /// updated in lockstep (web overlay handles this in PR #83's mergeHpUpdates).
  hp: number;
  /// Pre-weighted [0, 1] scores per component. Mirrors the per-token
  /// breakdown the leaderboard already consumes.
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
    holderConcentration: number;
  };
  /// `HP_WEIGHTS_VERSION` stamped at compute time. Lets clients alarm on
  /// version drift and skip stale frames after a weight change.
  weightsVersion: string;
  /// Block-timestamp seconds the recompute was anchored to.
  computedAt: number;
  /// What caused this recompute.
  trigger: HpRecomputeTrigger;
}

/// Builds the wire-format `TickerEvent` for an HP_UPDATED. Pure; tested
/// independently of the SSE hub.
export function buildHpUpdatedEvent(input: {
  id: number;
  tokenAddress: `0x${string}`;
  ticker: string;
  scored: ScoredToken;
  trigger: HpRecomputeTrigger;
  computedAtSec: bigint;
  isoNow: string;
}): TickerEvent {
  const c = input.scored.components;
  const data: HpUpdatedData = {
    // Scoring already returns integer HP in [0, 10000] — Epic 1.18.
    hp: input.scored.hp,
    components: {
      velocity: c.velocity.score,
      effectiveBuyers: c.effectiveBuyers.score,
      stickyLiquidity: c.stickyLiquidity.score,
      retention: c.retention.score,
      momentum: c.momentum.score,
      holderConcentration: c.holderConcentration.score,
    },
    weightsVersion: input.scored.weightsVersion,
    computedAt: Number(input.computedAtSec),
    trigger: input.trigger,
  };
  return {
    id: input.id,
    type: "HP_UPDATED",
    priority: "LOW",
    token: input.ticker,
    address: input.tokenAddress,
    // HP_UPDATED is data; the ticker UI suppresses empty-message rows.
    message: "",
    data: data as unknown as Record<string, unknown>,
    timestamp: input.isoNow,
  };
}

/// Cohort-wide vs single-token trigger semantics. Cohort triggers
/// (PHASE_BOUNDARY / CUT / FINALIZE) recompute every token's HP at once
/// because rank-relative components (velocity / effective-buyers /
/// stickyLiq min-max) shift across the whole cohort. Per-token triggers
/// (SWAP / HOLDER_SNAPSHOT) recompute the cohort but only WRITE the one
/// token whose state changed — the other tokens' scores haven't moved.
///
/// `BLOCK_TICK` is a periodic floor: cohort-wide write, ensures rows exist
/// for tokens with no recent activity.
export function isCohortWideTrigger(t: HpRecomputeTrigger): boolean {
  return t === "PHASE_BOUNDARY" || t === "CUT" || t === "FINALIZE" || t === "BLOCK_TICK";
}

/// Per-row provenance bundle for the hpSnapshot writer. Bundles the values
/// derived from a `ScoredToken` so the writer doesn't reach into the
/// scoring shape directly (decouples row construction from scoring's
/// internal representation).
export interface HpSnapshotRowInsert {
  id: string;
  token: `0x${string}`;
  snapshotAtSec: bigint;
  hp: number;
  rank: number;
  velocity: number;
  effectiveBuyers: number;
  stickyLiquidity: number;
  retention: number;
  momentum: number;
  phase: string;
  blockNumber: bigint;
  weightsVersion: string;
  flagsActive: string; // JSON
  trigger: HpRecomputeTrigger;
  /// Reorg-safety status (Epic 1.22 / spec §6.12). See ponder.schema for the
  /// state machine. Per-token triggers (SWAP / HOLDER_SNAPSHOT / BLOCK_TICK)
  /// land as `tip`; CUT / FINALIZE rows MUST land as `final` (the writer
  /// queues them until ≥12 blocks past the wall-clock boundary, so by the
  /// time we insert they are final by construction).
  finality: HpFinality;
}

/// Closed set of finality tags. Strings (not enum) so they round-trip cleanly
/// through Ponder's text columns.
export type HpFinality = "tip" | "soft" | "final";

/// Resolves the initial `finality` for a fresh hpSnapshot row given its
/// trigger. Settlement-tagged rows arrive only after the writer has waited
/// ≥12 blocks past the wall-clock boundary, so they land as `final` by
/// construction; everything else lands as `tip` (the periodic advancer will
/// promote them to `soft` and `final`).
export function initialFinalityForTrigger(t: HpRecomputeTrigger): HpFinality {
  if (t === "CUT" || t === "FINALIZE") return "final";
  return "tip";
}

/// Builds an `HpSnapshotRowInsert` from a scored cohort entry + the
/// recompute context. Pure; matches the signature the indexer's writer
/// hands to Drizzle. The `id` format is identical to the existing
/// BLOCK_TICK writer's so the unique constraint still holds — multiple
/// triggers landing in the same block-second collide and the latest
/// write wins (acceptable: same-block recomputes produce the same HP).
export function buildHpSnapshotInsert(args: {
  scored: ScoredToken;
  trigger: HpRecomputeTrigger;
  apiPhase: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): HpSnapshotRowInsert {
  const {scored, trigger, apiPhase, blockNumber, blockTimestamp} = args;
  return {
    id: `${scored.token}:${blockTimestamp.toString()}`.toLowerCase(),
    token: scored.token,
    snapshotAtSec: blockTimestamp,
    // Epic 1.18: scoring returns integer HP in [0, 10000] — the column type
    // and wire shape match without further conversion.
    hp: scored.hp,
    rank: scored.rank,
    velocity: scored.components.velocity.score,
    effectiveBuyers: scored.components.effectiveBuyers.score,
    stickyLiquidity: scored.components.stickyLiquidity.score,
    retention: scored.components.retention.score,
    momentum: scored.components.momentum.score,
    phase: apiPhase,
    blockNumber,
    weightsVersion: scored.weightsVersion,
    flagsActive: JSON.stringify(scored.flagsActive),
    trigger,
    finality: initialFinalityForTrigger(trigger),
  };
}
