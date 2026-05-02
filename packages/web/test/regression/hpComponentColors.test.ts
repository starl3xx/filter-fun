/// Audit H-Arena-4 (Phase 1, 2026-05-01) regression — HP_COMPONENT_COLORS spec lock.
///
/// Pre-fix every HP-breakdown bar shared a single cyan→pink gradient and every
/// label rendered in `C.dim`, defeating the at-a-glance "which component is weak?"
/// scan that per-component colours enable. ARENA_SPEC §6.5.3 maps each HP
/// component to its own colour: Velocity → pink, Buyers → cyan, Liquidity →
/// yellow, Retention → green. The fifth component (momentum) isn't enumerated in
/// the spec — we assign it C.purple, the only remaining broadcast-palette colour.
import {describe, expect, it} from "vitest";

import {HP_COMPONENT_COLORS, HP_KEYS_IN_ORDER} from "../../src/lib/arena/hpLabels.js";
import {C} from "../../src/lib/tokens.js";

describe("HP_COMPONENT_COLORS spec lock (Audit H-Arena-4)", () => {
  it("Velocity → pink", () => {
    expect(HP_COMPONENT_COLORS.velocity).toBe(C.pink);
  });

  it("Buyers (effectiveBuyers) → cyan", () => {
    expect(HP_COMPONENT_COLORS.effectiveBuyers).toBe(C.cyan);
  });

  it("Liquidity (stickyLiquidity) → yellow", () => {
    expect(HP_COMPONENT_COLORS.stickyLiquidity).toBe(C.yellow);
  });

  it("Retention → green", () => {
    expect(HP_COMPONENT_COLORS.retention).toBe(C.green);
  });

  it("Momentum → purple (extension; not in spec, distinct from all four)", () => {
    expect(HP_COMPONENT_COLORS.momentum).toBe(C.purple);
  });

  it("every HpKey has a component colour (no implicit fallback to a single gradient)", () => {
    for (const key of HP_KEYS_IN_ORDER) {
      expect(HP_COMPONENT_COLORS[key]).toBeTruthy();
    }
  });

  it("all five colours are distinct (so each bar reads as its own component)", () => {
    const values = HP_KEYS_IN_ORDER.map((k) => HP_COMPONENT_COLORS[k]);
    expect(new Set(values).size).toBe(values.length);
  });
});
