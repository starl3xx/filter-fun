/// Pure settlement-provenance alert evaluator (Epic 1.21 / spec §47.5).
///
/// Extracted out of `operator.ts` so tests can import without dragging in
/// Ponder's `@/generated` API context alias. The route handler in `operator.ts`
/// pulls fresh `season` + `phaseChange` rows from the DB and feeds each
/// season's pre-fetched data into this evaluator; the evaluator stays pure +
/// synchronous so the alert logic is testable in isolation.

export interface Alert {
  id: string;
  level: "warn" | "error";
  source: string;
  message: string;
  since: number; // unix seconds
  params?: Record<string, unknown>;
}

/// Alert thresholds (bugbot PR #95 round 3).
///
/// `SETTLEMENT_DRIFT_TOLERANCE_SEC` (10s) is the dispatch-spec'd tolerance for
/// the dashboard's drift indicator (the red-vs-green chip on each settlement-
/// provenance row). A drift > 10s is visually flagged because operators want
/// to spot drift early on the dashboard.
///
/// `SETTLEMENT_DRIFT_ALERT_SEC` (60s) is the threshold that fires the *alert*.
/// Block-time + oracle-scheduling jitter + RPC mempool latency routinely
/// account for 10-30s of drift even on a healthy deployment; a 10s alert
/// fires constant false positives and trains operators to ignore the banner
/// (alert fatigue). 60s is the smallest threshold that cleanly distinguishes
/// "scheduler/oracle is unhealthy" from normal block-inclusion variance.
///
/// `SETTLEMENT_MISSING_GRACE_SEC` (60s) is how long past the expected anchor
/// we wait before alerting on a missing transition. Same reasoning — the
/// scheduler may legitimately fire the tx 30-45s after the anchor due to
/// mempool latency; a 10s grace would near-always fire an alert that
/// auto-resolves a few seconds later.
export const SETTLEMENT_DRIFT_TOLERANCE_SEC = 10;
export const SETTLEMENT_DRIFT_ALERT_SEC = 60;
export const SETTLEMENT_MISSING_GRACE_SEC = 60;

/// Each phase-boundary transition is checked INDEPENDENTLY against its own
/// expected anchor. Bugbot PR #95 round 3 (High Severity): pre-fix the CUT
/// + FINALIZE checks shared a single `nowSec < expectedFinalize` gate, which
/// silently swallowed missing-CUT alerts until h168 (72h after they should
/// have surfaced). The per-transition gate fires the missing-CUT alert at
/// h96 + grace and missing-FINALIZE at h168 + grace.
export function evaluateSettlementProvenance(input: {
  seasonId: bigint;
  startedAtSec: number;
  cutTimestampSec?: bigint;
  finalizeTimestampSec?: bigint;
  nowSec: number;
}): Alert[] {
  const out: Alert[] = [];
  const expectedCut = input.startedAtSec + 96 * 3600;
  const expectedFinalize = input.startedAtSec + 168 * 3600;
  const seasonIdStr = input.seasonId.toString();

  if (input.nowSec >= expectedCut + SETTLEMENT_MISSING_GRACE_SEC) {
    if (input.cutTimestampSec === undefined) {
      out.push({
        id: `settlement_provenance_cut_missing:${seasonIdStr}`,
        level: "error",
        source: "oracle_provenance",
        message: `Season ${seasonIdStr} missed CUT transition`,
        since: expectedCut,
        params: {seasonId: seasonIdStr, expectedAt: expectedCut},
      });
    } else {
      const drift = Math.abs(Number(input.cutTimestampSec) - expectedCut);
      if (drift > SETTLEMENT_DRIFT_ALERT_SEC) {
        out.push({
          id: `settlement_provenance_cut_drift:${seasonIdStr}`,
          level: "warn",
          source: "oracle_provenance",
          message: `Season ${seasonIdStr} CUT drifted ${drift}s from h96`,
          since: Number(input.cutTimestampSec),
          params: {seasonId: seasonIdStr, driftSec: drift},
        });
      }
    }
  }

  if (input.nowSec >= expectedFinalize + SETTLEMENT_MISSING_GRACE_SEC) {
    if (input.finalizeTimestampSec === undefined) {
      out.push({
        id: `settlement_provenance_finalize_missing:${seasonIdStr}`,
        level: "error",
        source: "oracle_provenance",
        message: `Season ${seasonIdStr} missed FINALIZE transition`,
        since: expectedFinalize,
        params: {seasonId: seasonIdStr, expectedAt: expectedFinalize},
      });
    } else {
      const drift = Math.abs(Number(input.finalizeTimestampSec) - expectedFinalize);
      if (drift > SETTLEMENT_DRIFT_ALERT_SEC) {
        out.push({
          id: `settlement_provenance_finalize_drift:${seasonIdStr}`,
          level: "warn",
          source: "oracle_provenance",
          message: `Season ${seasonIdStr} FINALIZE drifted ${drift}s from h168`,
          since: Number(input.finalizeTimestampSec),
          params: {seasonId: seasonIdStr, driftSec: drift},
        });
      }
    }
  }
  return out;
}
