/// Tests for the pure settlement-alert evaluator — Epic 1.21 / spec §47.5.
/// Bugbot PR #95 round 3 regressions are pinned here.

import {describe, expect, it} from "vitest";

import {evaluateSettlementProvenance} from "../../src/api/operatorAlerts.js";

const seasonId = 1n;
const startedAtSec = 1_700_000_000; // arbitrary anchor
const expectedCut = startedAtSec + 96 * 3600;
const expectedFinalize = startedAtSec + 168 * 3600;

describe("evaluateSettlementProvenance", () => {
  // Round 3 High Severity: pre-fix both checks shared a single
  // `nowSec < expectedFinalize` gate, so a missing-CUT alert was silently
  // suppressed until h168 (72h late). These tests pin the per-transition gate.

  it("does not fire any alert before h96 + grace", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      nowSec: startedAtSec + 50 * 3600, // h50 — neither anchor reached
    });
    expect(alerts).toEqual([]);
  });

  it("fires the missing-CUT alert at h96 + grace, NOT delayed to h168", () => {
    // 65 seconds past h96 — past the 60-second grace. The pre-fix bug
    // silently suppressed this until nowSec >= h168. This test would fail
    // under the pre-fix gate.
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      nowSec: expectedCut + 65,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe("settlement_provenance_cut_missing:1");
    expect(alerts[0]!.level).toBe("error");
  });

  it("fires the missing-FINALIZE alert at h168 + grace", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      // Both transitions missing past the FINALIZE deadline.
      nowSec: expectedFinalize + 65,
    });
    expect(alerts).toHaveLength(2);
    const ids = alerts.map((a: {id: string}) => a.id);
    expect(ids).toContain("settlement_provenance_cut_missing:1");
    expect(ids).toContain("settlement_provenance_finalize_missing:1");
  });

  it("does NOT fire the missing alert during the grace window", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      nowSec: expectedCut + 30, // within the 60s grace
    });
    expect(alerts).toEqual([]);
  });

  // Round 3 Medium Severity: drift threshold widened from 10s to 60s. The
  // dispatch-spec'd 10s tolerance is preserved as the dashboard chip's
  // visual flag, but ALERTS only fire at 60s+ to avoid false-positive fatigue.

  it("does not fire a drift alert for 30s drift (within 60s threshold)", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      cutTimestampSec: BigInt(expectedCut + 30),
      nowSec: expectedCut + 100,
    });
    // 30s drift is past the dashboard chip's 10s tolerance (visual flag) but
    // below the 60s alert threshold — no alert fires.
    expect(alerts).toEqual([]);
  });

  it("fires a drift warn alert for >60s drift", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      cutTimestampSec: BigInt(expectedCut + 75),
      nowSec: expectedCut + 200,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe("settlement_provenance_cut_drift:1");
    expect(alerts[0]!.level).toBe("warn");
    expect(alerts[0]!.params?.driftSec).toBe(75);
  });

  it("does not fire a drift alert when the transition lands exactly on time", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      cutTimestampSec: BigInt(expectedCut),
      finalizeTimestampSec: BigInt(expectedFinalize),
      nowSec: expectedFinalize + 1000,
    });
    expect(alerts).toEqual([]);
  });

  it("fires drift alerts for both transitions independently", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      cutTimestampSec: BigInt(expectedCut + 100),
      finalizeTimestampSec: BigInt(expectedFinalize - 80),
      nowSec: expectedFinalize + 200,
    });
    expect(alerts.map((a: {id: string}) => a.id).sort()).toEqual([
      "settlement_provenance_cut_drift:1",
      "settlement_provenance_finalize_drift:1",
    ]);
  });

  it("the missing-CUT alert is independent of FINALIZE state (round 3 High regression)", () => {
    // Past h168 + grace, FINALIZE transition landed ON TIME, but CUT is
    // somehow missing. Pre-fix the CUT alert wouldn't fire because both
    // transitions shared a gate. Post-fix the CUT alert fires regardless.
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      finalizeTimestampSec: BigInt(expectedFinalize),
      nowSec: expectedFinalize + 100,
    });
    expect(alerts.map((a: {id: string}) => a.id)).toContain("settlement_provenance_cut_missing:1");
  });

  // Round 6 Medium: aborted seasons (sparse-week, terminated at h48) never
  // receive CUT/FINALIZE transitions by design. Pre-fix the missing-CUT alert
  // fired against them permanently once nowSec passed h96 + grace, training
  // operators to ignore the banner. Post-fix the evaluator returns [] for
  // any aborted season regardless of how far past h96 / h168 we are.

  it("returns no alerts for an aborted season past h96 + grace", () => {
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      // Past h96 + grace AND past h168 + grace — pre-fix would fire BOTH
      // missing alerts; post-fix returns [].
      nowSec: expectedFinalize + 1000,
      aborted: true,
    });
    expect(alerts).toEqual([]);
  });

  it("returns no alerts for an aborted season even with stray drift values", () => {
    // Defensive: if an aborted season somehow had a stale phaseChange row
    // (shouldn't happen in production but the evaluator must not assume),
    // we still suppress every alert.
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      cutTimestampSec: BigInt(expectedCut + 500),
      finalizeTimestampSec: BigInt(expectedFinalize - 500),
      nowSec: expectedFinalize + 1000,
      aborted: true,
    });
    expect(alerts).toEqual([]);
  });

  it("aborted: false evaluates normally (default behaviour preserved)", () => {
    // Sanity that the new param doesn't accidentally suppress alerts when
    // explicitly false — the abort gate must require the truthy value.
    const alerts = evaluateSettlementProvenance({
      seasonId,
      startedAtSec,
      nowSec: expectedCut + 100,
      aborted: false,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe("settlement_provenance_cut_missing:1");
  });
});
