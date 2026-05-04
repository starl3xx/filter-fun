/// Tests for the pure `/scoring/weights` handler — Epic 1.17a.
///
/// The route in `src/api/index.ts` is a thin Hono wrapper around
/// `buildScoringWeightsResponse`; testing the pure function is sufficient to
/// pin the wire shape, the env-flag plumbing, and the lock-version stamp.

import {describe, expect, it} from "vitest";

import {
  HP_WEIGHTS_ACTIVATED_AT,
  HP_WEIGHTS_SPEC_REF,
  HP_WEIGHTS_VERSION,
  LOCKED_WEIGHTS,
} from "@filter-fun/scoring";

import {buildScoringWeightsResponse} from "../../src/api/scoringWeights.js";

describe("/scoring/weights — handler", () => {
  it("returns the locked v4 weight set with provenance fields", () => {
    const r = buildScoringWeightsResponse({});
    expect(r.version).toBe(HP_WEIGHTS_VERSION);
    // Epic 1.18 (2026-05-05): version bumped to mark the int10k composite scale.
    expect(r.version).toBe("2026-05-05-v4-locked-int10k");
    expect(r.specRef).toBe(HP_WEIGHTS_SPEC_REF);
    expect(r.activatedAt).toBe(HP_WEIGHTS_ACTIVATED_AT);
    expect(r.activatedAt).toBe("2026-05-05T00:00:00Z");
    expect(r.weights).toEqual({
      velocity: 0.30,
      effectiveBuyers: 0.15,
      stickyLiquidity: 0.30,
      retention: 0.15,
      momentum: 0.00,
      holderConcentration: 0.10,
    });
    expect(r.weights.velocity).toBe(LOCKED_WEIGHTS.velocity);
    expect(r.phaseDifferentiation).toBe(false);
    const sum =
      r.weights.velocity +
      r.weights.effectiveBuyers +
      r.weights.stickyLiquidity +
      r.weights.retention +
      r.weights.momentum +
      r.weights.holderConcentration;
    expect(sum).toBeCloseTo(1, 9);
  });

  it("Epic 1.18 — exposes the composite-HP scale (int [0, 10000])", () => {
    const r = buildScoringWeightsResponse({});
    expect(r.compositeScale).toEqual({min: 0, max: 10000, type: "integer"});
  });

  it("flags default to momentum=false, concentration=true with empty env", () => {
    const r = buildScoringWeightsResponse({});
    expect(r.flags.HP_MOMENTUM_ENABLED).toBe(false);
    expect(r.flags.HP_CONCENTRATION_ENABLED).toBe(true);
  });

  it("env overrides flow through both flags", () => {
    const r = buildScoringWeightsResponse({
      HP_MOMENTUM_ENABLED: "true",
      HP_CONCENTRATION_ENABLED: "false",
    });
    expect(r.flags.HP_MOMENTUM_ENABLED).toBe(true);
    expect(r.flags.HP_CONCENTRATION_ENABLED).toBe(false);
  });

  it("is JSON-serialisable end-to-end (no bigints / Maps / Sets)", () => {
    const r = buildScoringWeightsResponse({});
    const round = JSON.parse(JSON.stringify(r));
    expect(round).toEqual(r);
  });
});
