/// Audit H-5 (Phase 1, 2026-05-01) regression — snapshot cadence drift.
///
/// Pre-fix snapshots were queried by `trigger = "CUT"` / `"FINALIZE"` with no check
/// that the actual on-chain timestamp matched spec §42's cadence (CUT @ hour 96,
/// FINALIZE @ hour 168 from `season.startedAt`). A delayed emit would silently
/// misrepresent when the snapshot was captured and downstream features
/// (filtersSurvived / weekWinner / filterSurvivor flags in profiles) drifted.
///
/// Post-fix `validateSnapshotCadence` returns a structured drift verdict the API
/// layer logs at `warn`. Drift never fails the request — operations decides whether
/// observed drift is real.
import {describe, expect, it, vi} from "vitest";

import {
  CUT_OFFSET_HOURS,
  DRIFT_THRESHOLD_SECONDS,
  FINALIZE_OFFSET_HOURS,
  checkAndLogCadence,
  validateSnapshotCadence,
  type CadenceLogger,
} from "../../../src/api/snapshotCadence.js";

const HOUR = 3600n;
const SEASON_STARTED_AT = 1_700_000_000n;

function spyLogger(): CadenceLogger & {calls: Array<unknown>} {
  const calls: Array<unknown> = [];
  return {
    warn: (fields) => {
      calls.push(fields);
    },
    calls,
  };
}

describe("snapshotCadence (Audit H-5)", () => {
  it("CUT exactly on cadence (hour 96) does not flag drift", () => {
    const v = validateSnapshotCadence({
      trigger: "CUT",
      blockTimestamp: SEASON_STARTED_AT + CUT_OFFSET_HOURS * HOUR,
      seasonStartedAt: SEASON_STARTED_AT,
      seasonId: 1n,
    });
    expect(v.drifted).toBe(false);
    expect(v.driftSeconds).toBe(0n);
    expect(v.expectedHour).toBe(96);
  });

  it("FINALIZE exactly on cadence (hour 168) does not flag drift", () => {
    const v = validateSnapshotCadence({
      trigger: "FINALIZE",
      blockTimestamp: SEASON_STARTED_AT + FINALIZE_OFFSET_HOURS * HOUR,
      seasonStartedAt: SEASON_STARTED_AT,
      seasonId: 1n,
    });
    expect(v.drifted).toBe(false);
  });

  it("drift within 5 minutes is tolerated (block-timing jitter, not a real problem)", () => {
    const v = validateSnapshotCadence({
      trigger: "CUT",
      // Exactly at the boundary: 5 min late, must NOT trip the threshold.
      blockTimestamp: SEASON_STARTED_AT + CUT_OFFSET_HOURS * HOUR + DRIFT_THRESHOLD_SECONDS,
      seasonStartedAt: SEASON_STARTED_AT,
      seasonId: 1n,
    });
    expect(v.drifted).toBe(false);
  });

  it("10 minutes late on CUT trips the drift verdict", () => {
    const v = validateSnapshotCadence({
      trigger: "CUT",
      blockTimestamp: SEASON_STARTED_AT + CUT_OFFSET_HOURS * HOUR + 10n * 60n,
      seasonStartedAt: SEASON_STARTED_AT,
      seasonId: 7n,
    });
    expect(v.drifted).toBe(true);
    expect(v.driftSeconds).toBe(600n);
    expect(v.expectedHour).toBe(96);
    expect(v.logFields).toMatchObject({
      event: "snapshot_cadence_drift",
      seasonId: "7",
      trigger: "CUT",
      expectedHour: 96,
      driftSeconds: "600",
    });
  });

  it("10 minutes early on FINALIZE also trips (signed drift, not magnitude)", () => {
    const v = validateSnapshotCadence({
      trigger: "FINALIZE",
      blockTimestamp: SEASON_STARTED_AT + FINALIZE_OFFSET_HOURS * HOUR - 10n * 60n,
      seasonStartedAt: SEASON_STARTED_AT,
      seasonId: 3n,
    });
    expect(v.drifted).toBe(true);
    expect(v.driftSeconds).toBe(-600n);
    expect(v.logFields.driftSeconds).toBe("-600");
  });

  it("unknown trigger label does not flag drift (no anchor to compare against)", () => {
    // A future contract change might add a third trigger. Until we know its cadence,
    // we silently accept rather than fire a false-positive warning every request.
    const v = validateSnapshotCadence({
      trigger: "MID_SEASON_SNAPSHOT",
      blockTimestamp: SEASON_STARTED_AT + 24n * HOUR,
      seasonStartedAt: SEASON_STARTED_AT,
      seasonId: 1n,
    });
    expect(v.drifted).toBe(false);
    expect(v.expectedHour).toBe(-1);
  });

  it("checkAndLogCadence emits the log on drift and stays silent otherwise", () => {
    const logger = spyLogger();
    // No drift — silent.
    checkAndLogCadence(
      {
        trigger: "CUT",
        blockTimestamp: SEASON_STARTED_AT + CUT_OFFSET_HOURS * HOUR,
        seasonStartedAt: SEASON_STARTED_AT,
        seasonId: 1n,
      },
      logger,
    );
    expect(logger.calls).toHaveLength(0);

    // 10-min late — fires.
    const verdict = checkAndLogCadence(
      {
        trigger: "CUT",
        blockTimestamp: SEASON_STARTED_AT + CUT_OFFSET_HOURS * HOUR + 10n * 60n,
        seasonStartedAt: SEASON_STARTED_AT,
        seasonId: 1n,
      },
      logger,
    );
    expect(verdict.drifted).toBe(true);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      event: "snapshot_cadence_drift",
      seasonId: "1",
      trigger: "CUT",
      expectedHour: 96,
      driftSeconds: "600",
    });
  });

  it("verdict.logFields contains every key a log aggregator pivots on", () => {
    // Pinned shape — log aggregators key on these field names. A rename would silently
    // break dashboards without firing a test elsewhere.
    const v = validateSnapshotCadence({
      trigger: "CUT",
      blockTimestamp: SEASON_STARTED_AT + CUT_OFFSET_HOURS * HOUR + 600n,
      seasonStartedAt: SEASON_STARTED_AT,
      seasonId: 5n,
    });
    expect(Object.keys(v.logFields).sort()).toEqual([
      "actualHour",
      "driftSeconds",
      "event",
      "expectedHour",
      "seasonId",
      "trigger",
    ]);
  });
});
