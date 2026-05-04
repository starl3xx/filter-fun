/// Tests for the HP recompute primitive — Epic 1.17b.
///
/// Pure helpers covered: `buildHpUpdatedEvent`, `buildHpSnapshotInsert`,
/// `isCohortWideTrigger`. The async DB+SSE writer is covered indirectly via
/// the handler integration tests once it lands; here we pin the wire shape
/// + row construction.

import {describe, expect, it} from "vitest";

import {
  HP_WEIGHTS_VERSION,
  type ScoredToken,
} from "@filter-fun/scoring";

import {
  buildHpSnapshotInsert,
  buildHpUpdatedEvent,
  initialFinalityForTrigger,
  isCohortWideTrigger,
  type HpRecomputeTrigger,
  type HpUpdatedData,
} from "../../src/api/hpRecompute.js";

const TOKEN = "0x000000000000000000000000000000000000000a" as `0x${string}`;

function fakeScoredToken(over: Partial<ScoredToken> = {}): ScoredToken {
  return {
    token: TOKEN,
    rank: 1,
    // Epic 1.18: integer in [0, 10000]. Pre-1.18 this was 0.87 (float).
    hp: 8700,
    phase: "preFilter",
    baseComposite: 0.85,
    weightsVersion: HP_WEIGHTS_VERSION,
    flagsActive: {momentum: false, concentration: true},
    components: {
      velocity: {score: 0.9, weight: 0.30, label: "Buying activity"},
      effectiveBuyers: {score: 0.7, weight: 0.15, label: "Real participants"},
      stickyLiquidity: {score: 0.8, weight: 0.30, label: "Liquidity strength"},
      retention: {score: 1.0, weight: 0.15, label: "Holder conviction"},
      momentum: {score: 0, weight: 0, label: "Momentum"},
      holderConcentration: {score: 0.4, weight: 0.10, label: "Holder distribution"},
    },
    ...over,
  };
}

describe("buildHpUpdatedEvent", () => {
  it("constructs the wire-shape HP_UPDATED ticker event", () => {
    const ev = buildHpUpdatedEvent({
      id: 42,
      tokenAddress: TOKEN,
      ticker: "$EDGE",
      scored: fakeScoredToken(),
      trigger: "SWAP",
      computedAtSec: 1_700_000_000n,
      isoNow: "2026-05-03T10:30:00.000Z",
    });
    expect(ev.id).toBe(42);
    expect(ev.type).toBe("HP_UPDATED");
    expect(ev.priority).toBe("LOW");
    expect(ev.token).toBe("$EDGE");
    expect(ev.address).toBe(TOKEN);
    expect(ev.message).toBe("");
    expect(ev.timestamp).toBe("2026-05-03T10:30:00.000Z");
    const data = ev.data as unknown as HpUpdatedData;
    // Epic 1.18: SSE payload carries the integer HP straight through (was 0-100).
    expect(data.hp).toBe(8700);
    expect(Number.isInteger(data.hp)).toBe(true);
    expect(data.components.holderConcentration).toBe(0.4);
    expect(data.weightsVersion).toBe(HP_WEIGHTS_VERSION);
    expect(data.computedAt).toBe(1_700_000_000);
    expect(data.trigger).toBe("SWAP");
  });

  it("preserves trigger label across the closed set", () => {
    for (const trig of [
      "BLOCK_TICK",
      "SWAP",
      "HOLDER_SNAPSHOT",
      "PHASE_BOUNDARY",
      "CUT",
      "FINALIZE",
    ] as HpRecomputeTrigger[]) {
      const ev = buildHpUpdatedEvent({
        id: 1,
        tokenAddress: TOKEN,
        ticker: "$X",
        scored: fakeScoredToken(),
        trigger: trig,
        computedAtSec: 0n,
        isoNow: "1970-01-01T00:00:00.000Z",
      });
      expect((ev.data as unknown as HpUpdatedData).trigger).toBe(trig);
    }
  });

  it("is JSON-serialisable end-to-end (no bigints / Maps / Sets in the payload)", () => {
    const ev = buildHpUpdatedEvent({
      id: 1,
      tokenAddress: TOKEN,
      ticker: "$X",
      scored: fakeScoredToken(),
      trigger: "SWAP",
      computedAtSec: 1_700_000_000n,
      isoNow: "2026-05-03T10:30:00.000Z",
    });
    const round = JSON.parse(JSON.stringify(ev));
    expect(round).toEqual(ev);
  });
});

describe("buildHpSnapshotInsert", () => {
  it("constructs a row that matches the schema's NOT-NULL columns", () => {
    const row = buildHpSnapshotInsert({
      scored: fakeScoredToken(),
      trigger: "SWAP",
      apiPhase: "competition",
      blockNumber: 12345n,
      blockTimestamp: 1_700_000_000n,
    });
    expect(row.id).toBe(`${TOKEN}:1700000000`);
    expect(row.token).toBe(TOKEN);
    expect(row.snapshotAtSec).toBe(1_700_000_000n);
    // Epic 1.18: hp is the integer scoring already returns (no scale conversion here).
    expect(row.hp).toBe(8700);
    expect(Number.isInteger(row.hp)).toBe(true);
    expect(row.rank).toBe(1);
    expect(row.velocity).toBe(0.9);
    expect(row.effectiveBuyers).toBe(0.7);
    expect(row.stickyLiquidity).toBe(0.8);
    expect(row.retention).toBe(1.0);
    expect(row.momentum).toBe(0);
    expect(row.phase).toBe("competition");
    expect(row.blockNumber).toBe(12345n);
    expect(row.weightsVersion).toBe(HP_WEIGHTS_VERSION);
    expect(row.flagsActive).toBe('{"momentum":false,"concentration":true}');
    expect(row.trigger).toBe("SWAP");
  });

  it("id is identical to the legacy BLOCK_TICK writer's id format", () => {
    // Existing BLOCK_TICK writer (HpSnapshot.ts) keys by `${token}:${snapshotAtSec}`.
    // Pinning this format is critical: a SWAP-tagged row landing in the same
    // block-second as a BLOCK_TICK-tagged row collides on the unique key, and
    // the second write wins (latest data — acceptable). If the format ever
    // diverged, history endpoints would silently double-count.
    const row = buildHpSnapshotInsert({
      scored: fakeScoredToken(),
      trigger: "BLOCK_TICK",
      apiPhase: "launch",
      blockNumber: 1n,
      blockTimestamp: 1_700_000_000n,
    });
    expect(row.id).toMatch(/^0x[0-9a-f]{40}:\d+$/);
    expect(row.id).toBe(`${TOKEN.toLowerCase()}:1700000000`);
  });
});

describe("isCohortWideTrigger", () => {
  it("PHASE_BOUNDARY / CUT / FINALIZE / BLOCK_TICK are cohort-wide", () => {
    expect(isCohortWideTrigger("PHASE_BOUNDARY")).toBe(true);
    expect(isCohortWideTrigger("CUT")).toBe(true);
    expect(isCohortWideTrigger("FINALIZE")).toBe(true);
    expect(isCohortWideTrigger("BLOCK_TICK")).toBe(true);
  });

  it("SWAP / HOLDER_SNAPSHOT are per-token", () => {
    expect(isCohortWideTrigger("SWAP")).toBe(false);
    expect(isCohortWideTrigger("HOLDER_SNAPSHOT")).toBe(false);
  });
});

describe("inv_hp_settlement_finality — initialFinalityForTrigger semantics (Epic 1.22 / spec §6.12)", () => {
  // The settlement contract: every CUT/FINALIZE-tagged hpSnapshot row MUST
  // have `finality = "final"` before the oracle Merkle publish reads it.
  // The writer enforces this by waiting ≥12 blocks past the wall-clock
  // boundary BEFORE inserting the row, so by construction CUT/FINALIZE
  // rows land as `final`. This test pins the boundary helper that resolves
  // the initial value.
  //
  // The full reorg/finality state machine (tip → soft → final advancement
  // for non-settlement rows) is the indexer projection's responsibility
  // — Epic 1.22b / PR 2 will land that periodic advancer.

  it("CUT-tagged rows initialize as final", () => {
    expect(initialFinalityForTrigger("CUT")).toBe("final");
  });

  it("FINALIZE-tagged rows initialize as final", () => {
    expect(initialFinalityForTrigger("FINALIZE")).toBe("final");
  });

  it("SWAP / HOLDER_SNAPSHOT / BLOCK_TICK / PHASE_BOUNDARY initialize as tip", () => {
    expect(initialFinalityForTrigger("SWAP")).toBe("tip");
    expect(initialFinalityForTrigger("HOLDER_SNAPSHOT")).toBe("tip");
    expect(initialFinalityForTrigger("BLOCK_TICK")).toBe("tip");
    expect(initialFinalityForTrigger("PHASE_BOUNDARY")).toBe("tip");
  });

  it("buildHpSnapshotInsert stamps the correct finality based on trigger", () => {
    const cutRow = buildHpSnapshotInsert({
      scored: fakeScoredToken(),
      trigger: "CUT",
      apiPhase: "finals",
      blockNumber: 1n,
      blockTimestamp: 1_700_000_000n,
    });
    expect(cutRow.finality).toBe("final");

    const swapRow = buildHpSnapshotInsert({
      scored: fakeScoredToken(),
      trigger: "SWAP",
      apiPhase: "competition",
      blockNumber: 1n,
      blockTimestamp: 1_700_000_000n,
    });
    expect(swapRow.finality).toBe("tip");
  });
});
