/// Tests for the hpSnapshot finality advancer — Epic 1.22b.
///
/// The state machine `tip → soft → final` is gated on block-number deltas
/// (FINALITY_SOFT_BLOCKS = 6, FINALITY_FINAL_BLOCKS = 12). The pure helpers
/// `nextFinality` + `finalityCutoffs` are sync + side-effect-free, so the
/// truth table is pinned here without a DB context.
///
/// The full SQL path (`runFinalityAdvancer`) is exercised in the integration
/// pass — vitest can't drive Drizzle directly. The pure helpers are the
/// authoritative source for which transition fires when, and the SQL path
/// merely batches the transitions into an UPDATE.

import {describe, expect, it} from "vitest";

import {
  FINALITY_FINAL_BLOCKS,
  FINALITY_SOFT_BLOCKS,
  finalityCutoffs,
  nextFinality,
  type HpFinality,
} from "../../src/api/finalityAdvancer.js";

describe("finalityCutoffs", () => {
  it("returns soft = head − 6, final = head − 12", () => {
    const c = finalityCutoffs(1000n);
    expect(c.softCutoff).toBe(1000n - FINALITY_SOFT_BLOCKS);
    expect(c.finalCutoff).toBe(1000n - FINALITY_FINAL_BLOCKS);
    expect(c.softCutoff).toBe(994n);
    expect(c.finalCutoff).toBe(988n);
  });

  it("handles head < FINAL_BLOCKS at chain genesis (cutoffs go negative — non-issue under bigint)", () => {
    const c = finalityCutoffs(5n);
    expect(c.softCutoff).toBe(-1n);
    expect(c.finalCutoff).toBe(-7n);
  });
});

describe("nextFinality — truth table", () => {
  const HEAD = 1000n;

  it("`final` rows never advance (idempotent floor)", () => {
    expect(nextFinality("final" as HpFinality, 100n, HEAD)).toBe(null);
    expect(nextFinality("final" as HpFinality, 999n, HEAD)).toBe(null);
  });

  it("`tip` row at head − 5 stays tip (under soft threshold)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - 5n, HEAD)).toBe(null);
  });

  it("`tip` row at head − 6 graduates to soft (boundary, ≤ softCutoff)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - FINALITY_SOFT_BLOCKS, HEAD)).toBe("soft");
  });

  it("`tip` row at head − 11 graduates to soft", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - 11n, HEAD)).toBe("soft");
  });

  it("`tip` row at head − 12 jumps straight to final (boundary, ≤ finalCutoff)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - FINALITY_FINAL_BLOCKS, HEAD)).toBe("final");
  });

  it("`tip` row at head − 100 jumps straight to final (one-step transition for stale rows)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - 100n, HEAD)).toBe("final");
  });

  it("`soft` row at head − 7 stays soft (between soft and final thresholds)", () => {
    expect(nextFinality("soft" as HpFinality, HEAD - 7n, HEAD)).toBe(null);
  });

  it("`soft` row at head − 12 graduates to final (boundary)", () => {
    expect(nextFinality("soft" as HpFinality, HEAD - FINALITY_FINAL_BLOCKS, HEAD)).toBe("final");
  });

  it("`soft` row at head − 50 graduates to final", () => {
    expect(nextFinality("soft" as HpFinality, HEAD - 50n, HEAD)).toBe("final");
  });
});

describe("nextFinality — settlement contract invariants", () => {
  // Per spec §6.12: rows tagged CUT/FINALIZE write as `final` directly (the
  // writer waits ≥12 blocks before insert). The advancer never sees them at
  // 'tip' or 'soft' under the documented writer flow — this test pins the
  // contract that even if a CUT row somehow landed at 'tip', the advancer's
  // monotonic floor makes it correct on the next tick.

  it("a 'tip' row from a CUT trigger is still safely advanceable to 'final' (defense-in-depth)", () => {
    // If somehow a CUT tag landed at 'tip' (writer bug, replay edge),
    // the advancer's transition is still correct: at head − 12, → final.
    expect(nextFinality("tip" as HpFinality, 100n, 200n)).toBe("final");
  });

  it("once 'final', no further transitions (settlement-stable)", () => {
    // The settlement publish path reads `final` rows. Once a row reaches
    // final, the advancer must NEVER demote it — even under a fresh tick
    // with the same row data, the answer is null.
    for (let head = 100n; head < 200n; head += 10n) {
      for (let blockNum = 0n; blockNum < head; blockNum += 5n) {
        expect(nextFinality("final" as HpFinality, blockNum, head)).toBe(null);
      }
    }
  });
});

describe("nextFinality — boundary precision (off-by-one resistance)", () => {
  // Off-by-one resistance: the spec says ≥ N blocks confirmation for each
  // tier. Our implementation uses `≤ cutoff` where cutoff = head − N.
  // A row at exactly N confirmations satisfies head − blockNum == N, so
  // blockNum == head − N, and head − N ≤ cutoff (head − N) → true.

  it("'tip' graduation fires at exactly FINALITY_SOFT_BLOCKS confirmations", () => {
    const HEAD = 100n;
    const exactlyAtSoft = HEAD - FINALITY_SOFT_BLOCKS;
    expect(nextFinality("tip", exactlyAtSoft, HEAD)).toBe("soft");

    const oneMoreThanSoft = HEAD - FINALITY_SOFT_BLOCKS + 1n;
    expect(nextFinality("tip", oneMoreThanSoft, HEAD)).toBe(null);
  });

  it("'soft' graduation fires at exactly FINALITY_FINAL_BLOCKS confirmations", () => {
    const HEAD = 100n;
    const exactlyAtFinal = HEAD - FINALITY_FINAL_BLOCKS;
    expect(nextFinality("soft", exactlyAtFinal, HEAD)).toBe("final");

    const oneMoreThanFinal = HEAD - FINALITY_FINAL_BLOCKS + 1n;
    expect(nextFinality("soft", oneMoreThanFinal, HEAD)).toBe(null);
  });
});
