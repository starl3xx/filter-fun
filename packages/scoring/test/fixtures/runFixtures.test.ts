/// Phase 3 — fixture-suite test runner. One vitest test per fixture file
/// under `test/fixtures/`. Failures point at the specific fixture name and
/// the expected vs actual delta.

import {describe, expect, it} from "vitest";

import {
  activeWeightsVersion,
  findFixtureFiles,
  fixtureRelativeName,
  loadComponentFixture,
  loadCompositeFixture,
  runComponentFixture,
  runCompositeFixture,
} from "./runFixtures.js";

describe("Phase 3 fixture suite — version gate", () => {
  it("every component fixture is tagged with the active HP_WEIGHTS_VERSION", () => {
    const files = findFixtureFiles("components");
    expect(files.length, "no component fixtures found under test/fixtures/components").toBeGreaterThan(0);
    const active = activeWeightsVersion();
    for (const f of files) {
      const fix = loadComponentFixture(f);
      expect(fix.weightsVersion, `${fixtureRelativeName(f)} weightsVersion mismatch`).toBe(active);
    }
  });

  it("every composite fixture is tagged with the active HP_WEIGHTS_VERSION", () => {
    const files = findFixtureFiles("composite");
    expect(files.length, "no composite fixtures found under test/fixtures/composite").toBeGreaterThan(0);
    const active = activeWeightsVersion();
    for (const f of files) {
      const fix = loadCompositeFixture(f);
      expect(fix.weightsVersion, `${fixtureRelativeName(f)} weightsVersion mismatch`).toBe(active);
    }
  });

  it("each component subdir has at least 5 fixtures (spec §6.13 minimum)", () => {
    const components = ["velocity", "effectiveBuyers", "stickyLiquidity", "retention", "holderConcentration"];
    for (const c of components) {
      const files = findFixtureFiles(`components/${c}`);
      expect(files.length, `${c} has ${files.length} fixtures (need ≥ 5)`).toBeGreaterThanOrEqual(5);
    }
  });

  it("composite suite has at least 10 fixtures (spec §6.13 minimum)", () => {
    const files = findFixtureFiles("composite");
    expect(files.length, `composite has ${files.length} fixtures (need ≥ 10)`).toBeGreaterThanOrEqual(10);
  });
});

describe("Phase 3 fixture suite — component fixtures", () => {
  const files = findFixtureFiles("components");
  for (const f of files) {
    const fix = loadComponentFixture(f);
    it(`${fixtureRelativeName(f)} — ${fix.description}`, () => {
      const {actual, expected, tolerance} = runComponentFixture(fix);
      expect(
        Math.abs(actual - expected),
        `expected ${expected} (±${tolerance}); got ${actual} (delta ${actual - expected})`,
      ).toBeLessThanOrEqual(tolerance);
    });
  }
});

describe("Phase 3 fixture suite — composite fixtures", () => {
  const files = findFixtureFiles("composite");
  for (const f of files) {
    const fix = loadCompositeFixture(f);
    it(`${fixtureRelativeName(f)} — ${fix.description}`, () => {
      const {scored, expected} = runCompositeFixture(fix);
      const byToken = new Map(scored.map((s) => [s.token.toLowerCase(), s]));
      for (const e of expected) {
        const row = byToken.get(e.token.toLowerCase());
        expect(row, `token ${e.token} missing from scored cohort`).toBeDefined();
        if (!row) continue;
        const tol = e.hpTolerance ?? 0;
        expect(
          Math.abs(row.hp - e.hp),
          `${e.token} expected hp=${e.hp} (±${tol}); got ${row.hp}`,
        ).toBeLessThanOrEqual(tol);
        expect(row.rank, `${e.token} expected rank=${e.rank}; got ${row.rank}`).toBe(e.rank);
      }
    });
  }
});
