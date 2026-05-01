import {describe, expect, it} from "vitest";

import {DEFAULT_CADENCE, hoursToSec, loadCadence, SECONDS_PER_HOUR} from "../src/index.js";

describe("DEFAULT_CADENCE", () => {
  it("matches the locked spec anchors (48 / 96 / 168, soft filter off)", () => {
    expect(DEFAULT_CADENCE).toEqual({
      launchEndHour: 48n,
      hardCutHour: 96n,
      settlementHour: 168n,
      softFilterEnabled: false,
    });
  });
});

describe("hoursToSec", () => {
  it("converts via SECONDS_PER_HOUR (3600)", () => {
    expect(SECONDS_PER_HOUR).toBe(3600n);
    expect(hoursToSec(0n)).toBe(0n);
    expect(hoursToSec(96n)).toBe(345_600n);
    expect(hoursToSec(168n)).toBe(604_800n);
  });
});

describe("loadCadence — defaults", () => {
  it("returns DEFAULT_CADENCE when env is empty", () => {
    expect(loadCadence({})).toEqual(DEFAULT_CADENCE);
  });

  it("treats empty-string overrides as unset", () => {
    expect(
      loadCadence({
        SEASON_LAUNCH_END_HOUR: "",
        SEASON_HARD_CUT_HOUR: "",
        SEASON_SETTLEMENT_HOUR: "",
        SEASON_SOFT_FILTER_ENABLED: "",
      }),
    ).toEqual(DEFAULT_CADENCE);
  });
});

describe("loadCadence — overrides", () => {
  it("applies a Sepolia-style compressed timeline", () => {
    const c = loadCadence({
      SEASON_LAUNCH_END_HOUR: "1",
      SEASON_HARD_CUT_HOUR: "2",
      SEASON_SETTLEMENT_HOUR: "3",
    });
    expect(c).toEqual({
      launchEndHour: 1n,
      hardCutHour: 2n,
      settlementHour: 3n,
      softFilterEnabled: false,
    });
  });

  it("accepts soft-filter true via every spelling", () => {
    expect(loadCadence({SEASON_SOFT_FILTER_ENABLED: "true"}).softFilterEnabled).toBe(true);
    expect(loadCadence({SEASON_SOFT_FILTER_ENABLED: "1"}).softFilterEnabled).toBe(true);
    expect(loadCadence({SEASON_SOFT_FILTER_ENABLED: "TRUE"}).softFilterEnabled).toBe(true);
  });

  it("accepts soft-filter false via every spelling", () => {
    expect(loadCadence({SEASON_SOFT_FILTER_ENABLED: "false"}).softFilterEnabled).toBe(false);
    expect(loadCadence({SEASON_SOFT_FILTER_ENABLED: "0"}).softFilterEnabled).toBe(false);
  });
});

describe("loadCadence — validation", () => {
  it("throws when hardCut <= launchEnd", () => {
    expect(() =>
      loadCadence({
        SEASON_LAUNCH_END_HOUR: "96",
        SEASON_HARD_CUT_HOUR: "96",
      }),
    ).toThrow(/SEASON_HARD_CUT_HOUR.*must be >.*SEASON_LAUNCH_END_HOUR/);
  });

  it("throws when settlement <= hardCut", () => {
    expect(() =>
      loadCadence({
        SEASON_HARD_CUT_HOUR: "168",
        SEASON_SETTLEMENT_HOUR: "168",
      }),
    ).toThrow(/SEASON_SETTLEMENT_HOUR.*must be >.*SEASON_HARD_CUT_HOUR/);
  });

  it("throws on a negative or zero hour", () => {
    expect(() => loadCadence({SEASON_HARD_CUT_HOUR: "0"})).toThrow(/positive integer/);
    expect(() => loadCadence({SEASON_HARD_CUT_HOUR: "-5"})).toThrow(/positive integer/);
  });

  it("throws on a non-integer", () => {
    expect(() => loadCadence({SEASON_HARD_CUT_HOUR: "96.5"})).toThrow(/positive integer/);
    expect(() => loadCadence({SEASON_HARD_CUT_HOUR: "ninety-six"})).toThrow(/positive integer/);
  });

  it("throws on an unrecognized soft-filter spelling", () => {
    expect(() => loadCadence({SEASON_SOFT_FILTER_ENABLED: "yes"})).toThrow(/true\/false\/1\/0/);
    expect(() => loadCadence({SEASON_SOFT_FILTER_ENABLED: "no"})).toThrow(/true\/false\/1\/0/);
    expect(() => loadCadence({SEASON_SOFT_FILTER_ENABLED: "garbage"})).toThrow(/true\/false\/1\/0/);
  });

  it("accepts mixed-case true/false (lowercase normalization is unambiguous)", () => {
    expect(loadCadence({SEASON_SOFT_FILTER_ENABLED: "True"}).softFilterEnabled).toBe(true);
    expect(loadCadence({SEASON_SOFT_FILTER_ENABLED: "False"}).softFilterEnabled).toBe(false);
  });
});
