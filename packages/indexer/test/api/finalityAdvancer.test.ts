/// Tests for the hpSnapshot finality advancer — Epic 1.22b, re-based to
/// wall-clock seconds in the 2026-07 Robinhood Chain retarget.
///
/// The state machine `tip → soft → final` is gated on block-TIMESTAMP deltas
/// (FINALITY_SOFT_SECONDS = 30, FINALITY_FINAL_SECONDS = 120) — block-count
/// deltas are meaningless on an on-demand-block Arbitrum-stack chain (see
/// src/api/finalityAdvancer.ts for the full rationale). The pure helpers
/// `nextFinality` + `finalityCutoffs` are sync + side-effect-free, so the
/// truth table is pinned here without a DB context.
///
/// The full SQL path (`runFinalityAdvancer`) is exercised in the integration
/// pass — vitest can't drive Drizzle directly. The pure helpers are the
/// authoritative source for which transition fires when, and the SQL path
/// merely batches the transitions into an UPDATE.

import {describe, expect, it} from "vitest";

import {
  FINALITY_FINAL_SECONDS,
  FINALITY_SOFT_SECONDS,
  finalityCutoffs,
  nextFinality,
  type HpFinality,
} from "../../src/api/finalityAdvancer.js";

describe("finalityCutoffs", () => {
  it("returns soft = head − 30s, final = head − 120s", () => {
    const c = finalityCutoffs(10_000n);
    expect(c.softCutoff).toBe(10_000n - FINALITY_SOFT_SECONDS);
    expect(c.finalCutoff).toBe(10_000n - FINALITY_FINAL_SECONDS);
    expect(c.softCutoff).toBe(9970n);
    expect(c.finalCutoff).toBe(9880n);
  });

  it("handles head < FINAL_SECONDS at chain genesis (cutoffs go negative — non-issue under bigint)", () => {
    const c = finalityCutoffs(5n);
    expect(c.softCutoff).toBe(5n - FINALITY_SOFT_SECONDS);
    expect(c.finalCutoff).toBe(5n - FINALITY_FINAL_SECONDS);
    expect(c.softCutoff < 0n).toBe(true);
    expect(c.finalCutoff < 0n).toBe(true);
  });
});

describe("nextFinality — truth table", () => {
  const HEAD = 10_000n;

  it("`final` rows never advance (idempotent floor)", () => {
    expect(nextFinality("final" as HpFinality, 100n, HEAD)).toBe(null);
    expect(nextFinality("final" as HpFinality, 9999n, HEAD)).toBe(null);
  });

  it("`tip` row written 29s ago stays tip (under soft threshold)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - (FINALITY_SOFT_SECONDS - 1n), HEAD)).toBe(null);
  });

  it("`tip` row written exactly SOFT_SECONDS ago graduates to soft (boundary, ≤ softCutoff)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - FINALITY_SOFT_SECONDS, HEAD)).toBe("soft");
  });

  it("`tip` row written 119s ago graduates to soft (just under final threshold)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - (FINALITY_FINAL_SECONDS - 1n), HEAD)).toBe("soft");
  });

  it("`tip` row written exactly FINAL_SECONDS ago jumps straight to final (boundary, ≤ finalCutoff)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - FINALITY_FINAL_SECONDS, HEAD)).toBe("final");
  });

  it("`tip` row written 1000s ago jumps straight to final (one-step transition for stale rows / idle-chain catch-up)", () => {
    expect(nextFinality("tip" as HpFinality, HEAD - 1000n, HEAD)).toBe("final");
  });

  it("`soft` row written 60s ago stays soft (between soft and final thresholds)", () => {
    expect(nextFinality("soft" as HpFinality, HEAD - 60n, HEAD)).toBe(null);
  });

  it("`soft` row written exactly FINAL_SECONDS ago graduates to final (boundary)", () => {
    expect(nextFinality("soft" as HpFinality, HEAD - FINALITY_FINAL_SECONDS, HEAD)).toBe("final");
  });

  it("`soft` row written 500s ago graduates to final", () => {
    expect(nextFinality("soft" as HpFinality, HEAD - 500n, HEAD)).toBe("final");
  });
});

describe("nextFinality — settlement contract invariants", () => {
  // Per spec §6.12: rows tagged CUT/FINALIZE write as `final` directly. The
  // advancer never sees them at 'tip' or 'soft' under the documented writer
  // flow — this test pins the contract that even if a CUT row somehow landed
  // at 'tip', the advancer's monotonic floor makes it correct on the next tick.

  it("a 'tip' row from a CUT trigger is still safely advanceable to 'final' (defense-in-depth)", () => {
    // If somehow a CUT tag landed at 'tip' (writer bug, replay edge),
    // the advancer's transition is still correct: at head − 120s, → final.
    expect(nextFinality("tip" as HpFinality, 100n, 100n + FINALITY_FINAL_SECONDS)).toBe("final");
  });

  it("once 'final', no further transitions (settlement-stable)", () => {
    // The settlement publish path reads `final` rows. Once a row reaches
    // final, the advancer must NEVER demote it — even under a fresh tick
    // with the same row data, the answer is null.
    for (let head = 1000n; head < 2000n; head += 100n) {
      for (let ts = 0n; ts < head; ts += 50n) {
        expect(nextFinality("final" as HpFinality, ts, head)).toBe(null);
      }
    }
  });
});

describe("nextFinality — boundary precision (off-by-one resistance)", () => {
  // Off-by-one resistance: the spec says ≥ N seconds of age for each tier.
  // Our implementation uses `≤ cutoff` where cutoff = head − N.
  // A row aged exactly N satisfies head − snapshotAtSec == N, so
  // snapshotAtSec == head − N, and head − N ≤ cutoff (head − N) → true.

  it("'tip' graduation fires at exactly FINALITY_SOFT_SECONDS of age", () => {
    const HEAD = 100_000n;
    const exactlyAtSoft = HEAD - FINALITY_SOFT_SECONDS;
    expect(nextFinality("tip", exactlyAtSoft, HEAD)).toBe("soft");

    const oneSecondYounger = HEAD - FINALITY_SOFT_SECONDS + 1n;
    expect(nextFinality("tip", oneSecondYounger, HEAD)).toBe(null);
  });

  it("'soft' graduation fires at exactly FINALITY_FINAL_SECONDS of age", () => {
    const HEAD = 100_000n;
    const exactlyAtFinal = HEAD - FINALITY_FINAL_SECONDS;
    expect(nextFinality("soft", exactlyAtFinal, HEAD)).toBe("final");

    const oneSecondYounger = HEAD - FINALITY_FINAL_SECONDS + 1n;
    expect(nextFinality("soft", oneSecondYounger, HEAD)).toBe(null);
  });
});
