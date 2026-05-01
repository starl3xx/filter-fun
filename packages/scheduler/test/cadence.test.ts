import {describe, expect, it} from "vitest";

import {DEFAULT_CADENCE, hoursToSec, loadCadence} from "../src/index.js";

/// Smoke tests proving `@filter-fun/scheduler` re-exports the cadence surface. The
/// scheduler library itself doesn't fire timers — it's a transaction driver — but external
/// harnesses (cron / Railway / manual ops) that drive `advancePhase()` import the cadence
/// constants from here so there's a single entrypoint per package.
describe("scheduler re-exports @filter-fun/cadence", () => {
  it("DEFAULT_CADENCE matches the spec-locked anchors", () => {
    expect(DEFAULT_CADENCE.launchEndHour).toBe(48n);
    expect(DEFAULT_CADENCE.hardCutHour).toBe(96n);
    expect(DEFAULT_CADENCE.settlementHour).toBe(168n);
    expect(DEFAULT_CADENCE.softFilterEnabled).toBe(false);
  });

  it("hoursToSec works on the Day 4 cut anchor", () => {
    expect(hoursToSec(96n)).toBe(345_600n);
  });

  it("loadCadence honors env overrides through the scheduler entrypoint", () => {
    const cadence = loadCadence({
      SEASON_HARD_CUT_HOUR: "100",
      SEASON_SETTLEMENT_HOUR: "200",
    });
    expect(cadence.hardCutHour).toBe(100n);
    expect(cadence.settlementHour).toBe(200n);
  });

  it("loadCadence rejects invalid env at startup (loud failure)", () => {
    expect(() =>
      loadCadence({
        SEASON_HARD_CUT_HOUR: "20",
        SEASON_LAUNCH_END_HOUR: "48",
      }),
    ).toThrow(/SEASON_HARD_CUT_HOUR.*must be >.*SEASON_LAUNCH_END_HOUR/);
  });
});
