import {describe, expect, it} from "vitest";

import {
  finalSettlementAtIso,
  nextCutAtIso,
  nextCutEpochSec,
  toApiPhase,
} from "../../src/api/phase.js";

const HOUR = 3600n;
const STARTED_AT = 1_700_000_000n; // a fixed Unix-second anchor unrelated to wall clock

describe("toApiPhase", () => {
  it("collapses Settlement + Closed into 'settled'", () => {
    expect(toApiPhase("Settlement")).toBe("settled");
    expect(toApiPhase("Closed")).toBe("settled");
  });

  it("maps the other three phases 1:1", () => {
    expect(toApiPhase("Launch")).toBe("launch");
    expect(toApiPhase("Filter")).toBe("competition");
    expect(toApiPhase("Finals")).toBe("finals");
  });

  it("falls back to 'launch' for unknown strings", () => {
    expect(toApiPhase("garbage")).toBe("launch");
  });
});

describe("nextCutEpochSec — locked cadence (96h cut, 168h settlement)", () => {
  it("returns startedAt + 96h while in launch", () => {
    expect(nextCutEpochSec(STARTED_AT, "launch")).toBe(STARTED_AT + 96n * HOUR);
  });

  it("returns startedAt + 96h while in competition", () => {
    expect(nextCutEpochSec(STARTED_AT, "competition")).toBe(STARTED_AT + 96n * HOUR);
  });

  it("shifts to startedAt + 168h once finals begin", () => {
    expect(nextCutEpochSec(STARTED_AT, "finals")).toBe(STARTED_AT + 168n * HOUR);
  });

  it("returns null in settled (no future cut)", () => {
    expect(nextCutEpochSec(STARTED_AT, "settled")).toBeNull();
  });
});

describe("nextCutAtIso — locked cadence", () => {
  it("renders Day 4 cut as ISO for launch + competition", () => {
    const expected = new Date(Number(STARTED_AT + 96n * HOUR) * 1000).toISOString();
    expect(nextCutAtIso(STARTED_AT, "launch")).toBe(expected);
    expect(nextCutAtIso(STARTED_AT, "competition")).toBe(expected);
  });

  it("renders Day 7 settlement as ISO once in finals", () => {
    const expected = new Date(Number(STARTED_AT + 168n * HOUR) * 1000).toISOString();
    expect(nextCutAtIso(STARTED_AT, "finals")).toBe(expected);
  });
});

describe("finalSettlementAtIso", () => {
  it("always renders startedAt + 168h regardless of phase", () => {
    const expected = new Date(Number(STARTED_AT + 168n * HOUR) * 1000).toISOString();
    expect(finalSettlementAtIso(STARTED_AT)).toBe(expected);
  });
});
