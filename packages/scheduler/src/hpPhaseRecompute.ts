/// Phase-boundary HP recompute scheduler — Epic 1.17b compute pathway.
///
/// Fires an HP recompute at the locked cadence boundaries (h0/24/48/72/96/168
/// from `season.startedAt`). The actual recompute runs on the indexer side
/// (via DB write); the scheduler's job is only to TRIGGER it at the right
/// wall-clock time. This module owns:
///
///   - the boundary-arithmetic helpers (pure, tested below)
///   - a `runTick` driver that resolves "what trigger should fire NOW" against
///     the current season + clock, and dispatches via an injected webhook
///     callback
///
/// Trigger mapping per dispatch (Epic 1.17b):
///   - h0   → PHASE_BOUNDARY (season open — establishes the baseline cohort)
///   - h24  → PHASE_BOUNDARY
///   - h48  → PHASE_BOUNDARY (launch closes / Filter opens — phase advance)
///   - h72  → PHASE_BOUNDARY
///   - h96  → CUT            (settlement-authoritative; oracle Merkle-publishes
///                            the resulting ranking BEFORE SeasonVault.cut())
///   - h168 → FINALIZE       (winner-declaration data; oracle Merkle-publishes
///                            BEFORE SeasonVault.submitWinner())
///
/// Tolerance: each boundary has a ±10s window. A tick fired within the
/// window for the first time is the one that "owns" that boundary; later
/// ticks within the same window are ignored (handled via the `firedFor`
/// state passed in — caller is responsible for persistence).
///
/// **Why the trigger split.** PHASE_BOUNDARY is observability — every
/// boundary writes one cohort-wide hpSnapshot row regardless of how the
/// trade activity stacked up. CUT and FINALIZE are the two
/// settlement-authoritative anchors that the oracle Merkle-publishes for
/// the on-chain settlement tx (spec §6.8 + §42.2.6 oracle authority). The
/// indexer treats CUT/FINALIZE-tagged rows as the "official" snapshot for
/// the season's outcome — auditors can join settlement tx → Merkle root →
/// hpSnapshot row by `weightsVersion` + block-time.

export type HpPhaseTrigger = "PHASE_BOUNDARY" | "CUT" | "FINALIZE";

export interface PhaseBoundary {
  /// Hours since `season.startedAt`.
  hour: 0 | 24 | 48 | 72 | 96 | 168;
  /// Wall-clock seconds at which the boundary fires.
  atSec: bigint;
  /// Trigger label stamped on the resulting hpSnapshot row(s).
  trigger: HpPhaseTrigger;
}

/// All six boundaries for a season starting at `startedAtSec`. Sorted by
/// ascending `atSec`.
export function phaseBoundaries(startedAtSec: bigint): PhaseBoundary[] {
  const HOUR = 3600n;
  return [
    {hour: 0,   atSec: startedAtSec + 0n   * HOUR, trigger: "PHASE_BOUNDARY"},
    {hour: 24,  atSec: startedAtSec + 24n  * HOUR, trigger: "PHASE_BOUNDARY"},
    {hour: 48,  atSec: startedAtSec + 48n  * HOUR, trigger: "PHASE_BOUNDARY"},
    {hour: 72,  atSec: startedAtSec + 72n  * HOUR, trigger: "PHASE_BOUNDARY"},
    {hour: 96,  atSec: startedAtSec + 96n  * HOUR, trigger: "CUT"},
    {hour: 168, atSec: startedAtSec + 168n * HOUR, trigger: "FINALIZE"},
  ];
}

/// Tolerance window for boundary firing. A tick whose `nowSec` is within
/// ±this many seconds of a boundary's `atSec` is considered "for" that
/// boundary. Spec §6.8 — 10s tolerance.
export const BOUNDARY_TOLERANCE_SEC = 10n;

/// Resolves which boundary (if any) the tick at `nowSec` belongs to. Returns
/// `null` outside any tolerance window. Pure.
export function boundaryForTick(
  startedAtSec: bigint,
  nowSec: bigint,
): PhaseBoundary | null {
  const boundaries = phaseBoundaries(startedAtSec);
  for (const b of boundaries) {
    const delta = nowSec >= b.atSec ? nowSec - b.atSec : b.atSec - nowSec;
    if (delta <= BOUNDARY_TOLERANCE_SEC) return b;
  }
  return null;
}

/// Idempotency state — caller persists this across ticks. The driver
/// records which (seasonId, hour) it has already fired for so a second
/// tick within the same boundary window is a no-op. Persistence model is
/// caller-owned (in-memory, JSON file, DB row); this module just consumes
/// + updates the snapshot.
export interface PhaseRecomputeState {
  /// Set of `${seasonId}:${hour}` keys already fired.
  firedFor: Set<string>;
}

export function makeEmptyState(): PhaseRecomputeState {
  return {firedFor: new Set()};
}

export interface PhaseTickResult {
  /// `null` when no boundary tick was fired (outside tolerance OR already fired).
  fired: {boundary: PhaseBoundary; webhookOk: boolean} | null;
}

/// Webhook: dispatches one cohort-wide HP recompute on the indexer side.
/// Implementations can post to an internal HTTP endpoint, write a DB row
/// the indexer polls, or invoke a direct RPC. The scheduler doesn't care —
/// returns `true` on success, `false` on dispatch failure (caller may retry).
export type PhaseRecomputeWebhook = (
  seasonId: bigint,
  trigger: HpPhaseTrigger,
  hour: number,
) => Promise<boolean>;

/// Runs one tick of the phase-boundary scheduler. Pure-ish: reads `nowSec`,
/// consults the boundary table, fires the webhook for any unhit boundary
/// in tolerance, and updates `state.firedFor`. Returns what (if anything) fired.
export async function runPhaseTick(
  state: PhaseRecomputeState,
  args: {
    seasonId: bigint;
    seasonStartedAtSec: bigint;
    nowSec: bigint;
  },
  webhook: PhaseRecomputeWebhook,
): Promise<PhaseTickResult> {
  const b = boundaryForTick(args.seasonStartedAtSec, args.nowSec);
  if (!b) return {fired: null};
  const key = `${args.seasonId}:${b.hour}`;
  if (state.firedFor.has(key)) return {fired: null};
  const ok = await webhook(args.seasonId, b.trigger, b.hour);
  if (ok) state.firedFor.add(key);
  return {fired: {boundary: b, webhookOk: ok}};
}
