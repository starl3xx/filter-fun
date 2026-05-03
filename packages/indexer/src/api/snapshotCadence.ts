/// Snapshot cadence validator — Audit H-5 (Phase 1, 2026-05-01)
///
/// Holder snapshots carry a trigger label (`CUT` | `FINALIZE`) but no on-chain check
/// that the actual block timestamp matches spec §42's cadence (CUT at hour 96,
/// FINALIZE at hour 168 from the season's `startedAt`). If the chain delays the emit
/// (block congestion, oracle batch latency), the trigger label silently misrepresents
/// when the snapshot was captured — downstream features that assume the cadence
/// (filtersSurvived, weekWinner, filterSurvivor flags in profiles) drift quietly.
///
/// This module is the pre-flight check: synthetic-input pure function, no DB or
/// HTTP coupling, returns a structured drift verdict that the API layer logs at
/// warn (not error — drift is operational, not exception-grade) and continues.
/// Operations decides whether observed drift is real or just block-timing jitter.

const SECONDS_PER_HOUR = 3600n;

/// Spec §42 cadence anchors. Names mirror the on-chain enum so a future contract
/// change that adds a third trigger (e.g. an early-finalize path) reads as a
/// missing case rather than a surprise.
export const CUT_OFFSET_HOURS = 96n;
export const FINALIZE_OFFSET_HOURS = 168n;

/// Audit L-Indexer-4 (Phase 1, 2026-05-01): canonical type for the holder snapshot
/// trigger label. Re-export so consumers (`/api/index.ts` `holderBadgeFlagsForUser`,
/// `events/tick.ts` cadence call site) compare against this union instead of bare
/// string literals — single source of truth for the legal label set.
///
/// Adding a third trigger requires:
///   1. Extend this union here.
///   2. Decide the cadence anchor in `validateSnapshotCadence` below — unknown
///      labels currently silently accept (returning `drifted: false`), so a
///      forgotten step here is operationally non-fatal but loses observability.
export type HolderSnapshotTrigger = "CUT" | "FINALIZE";

/// Drift threshold above which we surface a warning. 5 minutes is a deliberate
/// over-budget for normal chain timing variance: Base mainnet posts L1 batches at
/// roughly 2-second cadence; the worst-case oracle-emit latency we've seen on Sepolia
/// is ~30 seconds. 5 minutes catches genuine cadence problems (oracle stalled, batch
/// missed, manual intervention) without firing on routine block jitter.
export const DRIFT_THRESHOLD_SECONDS = 300n;

export interface SnapshotCadenceInput {
  trigger: HolderSnapshotTrigger | string;
  /// Snapshot timestamp from the chain (`holderSnapshot.blockTimestamp`).
  blockTimestamp: bigint;
  /// Season anchor (`season.startedAt`).
  seasonStartedAt: bigint;
  seasonId: bigint;
}

export interface SnapshotCadenceVerdict {
  /// True iff drift exceeded `DRIFT_THRESHOLD_SECONDS`. Callers log + carry on; this
  /// is never a request-failing condition.
  drifted: boolean;
  /// Signed: positive = snapshot landed late, negative = early.
  driftSeconds: bigint;
  expectedHour: number;
  actualHourFloor: number;
  /// Stable shape for structured logging — every field a log aggregator wants to
  /// pivot on (seasonId + trigger for grouping; expectedHour for cohort comparison;
  /// driftSeconds for severity).
  logFields: {
    event: "snapshot_cadence_drift";
    seasonId: string;
    trigger: string;
    expectedHour: number;
    actualHour: number;
    driftSeconds: string;
  };
}

/// Returns the cadence verdict. `drifted: false` for unknown trigger labels — we
/// don't presume a cadence we can't anchor; the warning would be noise.
export function validateSnapshotCadence(input: SnapshotCadenceInput): SnapshotCadenceVerdict {
  const expectedHours = expectedHoursFor(input.trigger);
  const elapsedSec = input.blockTimestamp - input.seasonStartedAt;
  const actualHourFloor = Number(elapsedSec / SECONDS_PER_HOUR);

  if (expectedHours === null) {
    return {
      drifted: false,
      driftSeconds: 0n,
      expectedHour: -1,
      actualHourFloor,
      logFields: {
        event: "snapshot_cadence_drift",
        seasonId: input.seasonId.toString(),
        trigger: input.trigger,
        expectedHour: -1,
        actualHour: actualHourFloor,
        driftSeconds: "0",
      },
    };
  }

  const expectedSec = expectedHours * SECONDS_PER_HOUR;
  const driftSeconds = elapsedSec - expectedSec;
  const absDrift = driftSeconds < 0n ? -driftSeconds : driftSeconds;
  const drifted = absDrift > DRIFT_THRESHOLD_SECONDS;

  return {
    drifted,
    driftSeconds,
    expectedHour: Number(expectedHours),
    actualHourFloor,
    logFields: {
      event: "snapshot_cadence_drift",
      seasonId: input.seasonId.toString(),
      trigger: input.trigger,
      expectedHour: Number(expectedHours),
      actualHour: actualHourFloor,
      driftSeconds: driftSeconds.toString(),
    },
  };
}

function expectedHoursFor(trigger: string): bigint | null {
  if (trigger === "CUT") return CUT_OFFSET_HOURS;
  if (trigger === "FINALIZE") return FINALIZE_OFFSET_HOURS;
  return null;
}

/// Minimal logger interface so the call-site can pass either `console` (production
/// default) or a vitest spy (tests). Single `warn` method is all this surface needs;
/// extracting a full logger now would be premature and add a dependency.
export interface CadenceLogger {
  warn(fields: SnapshotCadenceVerdict["logFields"]): void;
}

/// Convenience emitter: validate + log if drifted. Returns the verdict so callers
/// can use it for downstream filtering decisions. The logger argument is required to
/// keep ambient `console.warn` usage out of the call path; pass `consoleCadenceLogger`
/// at the wiring site if you don't have a structured logger to hand.
export function checkAndLogCadence(input: SnapshotCadenceInput, logger: CadenceLogger): SnapshotCadenceVerdict {
  const verdict = validateSnapshotCadence(input);
  if (verdict.drifted) logger.warn(verdict.logFields);
  return verdict;
}

/// Default logger — wraps `console.warn` with structured-fields convention so a future
/// switch to (say) pino/winston only changes this one wrapper.
export const consoleCadenceLogger: CadenceLogger = {
  warn(fields) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify(fields));
  },
};
