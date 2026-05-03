/// Tests for the live HP overlay derived from the SSE stream — Epic 1.17c.
///
/// Pure-function coverage: the hook just folds events into a Map; the merger
/// applies the overlay to a polled cohort; freshHpUpdateSeqByAddress reads
/// the receivedAt timestamps and exposes a per-token sequence id for the
/// pulse-animation `key`. The hook itself is a thin useMemo wrapper, so we
/// exercise it via the renderHook seam.

import {renderHook} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {
  freshHpUpdateSeqByAddress,
  mergeHpUpdates,
  useHpUpdates,
  type HpUpdate,
} from "@/hooks/arena/useHpUpdates";
import type {HpUpdatedData, TickerEvent} from "@/lib/arena/api";

import {makeFixtureCohort} from "./fixtures";

const TOKEN_A = "0x0000000000000000000000000000000000000001" as const;
const TOKEN_B = "0x0000000000000000000000000000000000000002" as const;

function hpUpdatedEvent(over: Partial<TickerEvent> & {address: `0x${string}`; data: HpUpdatedData}): TickerEvent {
  return {
    id: 1,
    type: "HP_UPDATED",
    priority: "LOW",
    token: "$X",
    message: "",
    timestamp: new Date().toISOString(),
    ...over,
  };
}

function fakeHpData(over: Partial<HpUpdatedData> = {}): HpUpdatedData {
  return {
    hp: 87,
    components: {
      velocity: 0.9,
      effectiveBuyers: 0.7,
      stickyLiquidity: 0.8,
      retention: 1.0,
      momentum: 0.0,
      holderConcentration: 0.4,
    },
    weightsVersion: "2026-05-03-v4-locked",
    computedAt: 1_700_000_000,
    trigger: "SWAP",
    ...over,
  };
}

describe("useHpUpdates", () => {
  it("returns an empty (stable) map when no HP_UPDATED events are present", () => {
    const events: TickerEvent[] = [
      {
        id: 1,
        type: "RANK_CHANGED",
        priority: "MEDIUM",
        token: "$A",
        address: TOKEN_A,
        message: "",
        data: {},
        timestamp: new Date().toISOString(),
      },
    ];
    const {result, rerender} = renderHook(({evs}: {evs: TickerEvent[]}) => useHpUpdates(evs), {
      initialProps: {evs: events},
    });
    const first = result.current.hpByAddress;
    expect(first.size).toBe(0);
    // A new events array (still no HP_UPDATED) MUST yield the same map
    // reference — otherwise downstream memos invalidate on every SSE event.
    rerender({evs: [...events]});
    expect(result.current.hpByAddress).toBe(first);
  });

  it("captures the freshest HP_UPDATED per token (by computedAt)", () => {
    const events: TickerEvent[] = [
      hpUpdatedEvent({id: 3, address: TOKEN_A, data: fakeHpData({hp: 90, computedAt: 1_700_000_005})}),
      hpUpdatedEvent({id: 2, address: TOKEN_B, data: fakeHpData({hp: 50, computedAt: 1_700_000_003})}),
      hpUpdatedEvent({id: 1, address: TOKEN_A, data: fakeHpData({hp: 70, computedAt: 1_700_000_001})}),
    ];
    const {result} = renderHook(() => useHpUpdates(events));
    expect(result.current.hpByAddress.size).toBe(2);
    expect(result.current.hpByAddress.get(TOKEN_A.toLowerCase())!.hp).toBe(90);
    expect(result.current.hpByAddress.get(TOKEN_B.toLowerCase())!.hp).toBe(50);
  });

  it("ignores stale HP_UPDATED frames that arrive after a newer one", () => {
    const events: TickerEvent[] = [
      hpUpdatedEvent({id: 2, address: TOKEN_A, data: fakeHpData({hp: 90, computedAt: 1_700_000_005})}),
      hpUpdatedEvent({id: 3, address: TOKEN_A, data: fakeHpData({hp: 70, computedAt: 1_700_000_001})}),
    ];
    const {result} = renderHook(() => useHpUpdates(events));
    expect(result.current.hpByAddress.get(TOKEN_A.toLowerCase())!.hp).toBe(90);
  });

  it("skips HP_UPDATED frames missing the address field", () => {
    const events: TickerEvent[] = [
      hpUpdatedEvent({id: 1, address: TOKEN_A, data: fakeHpData()}),
      {
        id: 2,
        type: "HP_UPDATED",
        priority: "LOW",
        token: null,
        address: null,
        message: "",
        data: fakeHpData(),
        timestamp: new Date().toISOString(),
      },
    ];
    const {result} = renderHook(() => useHpUpdates(events));
    expect(result.current.hpByAddress.size).toBe(1);
  });

  it("preserves map identity when a no-op recompute lands (same hp + components, new metadata) (bugbot M PR #83 round 2)", () => {
    // Initial: SWAP at computedAt=100 with hp=87.
    const initial: TickerEvent[] = [
      hpUpdatedEvent({id: 1, address: TOKEN_A, data: fakeHpData({hp: 87, computedAt: 100, trigger: "SWAP"})}),
    ];
    const {result, rerender} = renderHook(({evs}: {evs: TickerEvent[]}) => useHpUpdates(evs), {
      initialProps: {evs: initial},
    });
    const firstMap = result.current.hpByAddress;
    // BLOCK_TICK at computedAt=200 lands — same hp + identical components,
    // just new metadata. The hook MUST keep the previous map reference so
    // the leaderboard's pulse seq (derived from computedAt) doesn't bump
    // and trigger the cyan pulse animation on a no-op recompute.
    const next: TickerEvent[] = [
      hpUpdatedEvent({
        id: 2, address: TOKEN_A,
        timestamp: new Date(Date.now() + 1000).toISOString(),
        data: fakeHpData({hp: 87, computedAt: 200, trigger: "BLOCK_TICK"}),
      }),
      ...initial,
    ];
    rerender({evs: next});
    expect(result.current.hpByAddress).toBe(firstMap);
    // And the seq stayed at the original computedAt — confirms the
    // pulse won't replay on the BLOCK_TICK.
    expect(result.current.hpByAddress.get(TOKEN_A.toLowerCase())!.computedAt).toBe(100);
  });

  it("invalidates map identity when components change at the same hp value", () => {
    const initial: TickerEvent[] = [
      hpUpdatedEvent({id: 1, address: TOKEN_A, data: fakeHpData({hp: 87, computedAt: 100})}),
    ];
    const {result, rerender} = renderHook(({evs}: {evs: TickerEvent[]}) => useHpUpdates(evs), {
      initialProps: {evs: initial},
    });
    const firstMap = result.current.hpByAddress;
    // Same integer HP (87) but a component shifted — the recompute IS
    // meaningful for the detail panel even though the bar height looks
    // identical. Hook must adopt the new map.
    const next: TickerEvent[] = [
      hpUpdatedEvent({
        id: 2, address: TOKEN_A,
        data: fakeHpData({
          hp: 87, computedAt: 200,
          components: {
            velocity: 0.1, // changed from 0.9
            effectiveBuyers: 0.7, stickyLiquidity: 0.8, retention: 1.0,
            momentum: 0.0, holderConcentration: 0.4,
          },
        }),
      }),
      ...initial,
    ];
    rerender({evs: next});
    expect(result.current.hpByAddress).not.toBe(firstMap);
    expect(result.current.hpByAddress.get(TOKEN_A.toLowerCase())!.components.velocity).toBe(0.1);
  });

  it("preserves map identity when an unrelated event arrives (bugbot M PR #83)", () => {
    // Initial: one HP_UPDATED.
    const initial: TickerEvent[] = [
      hpUpdatedEvent({id: 1, address: TOKEN_A, data: fakeHpData({hp: 90, computedAt: 1_700_000_001})}),
    ];
    const {result, rerender} = renderHook(({evs}: {evs: TickerEvent[]}) => useHpUpdates(evs), {
      initialProps: {evs: initial},
    });
    const firstMap = result.current.hpByAddress;
    expect(firstMap.size).toBe(1);
    // A non-HP event lands on the buffer — events array changes identity,
    // but HP content does not. The hook must return the same map.
    const next: TickerEvent[] = [
      {
        id: 2, type: "RANK_CHANGED", priority: "MEDIUM", token: "$B", address: TOKEN_B,
        message: "rank shuffle", data: {}, timestamp: new Date().toISOString(),
      },
      ...initial,
    ];
    rerender({evs: next});
    expect(result.current.hpByAddress).toBe(firstMap);
  });
});

describe("mergeHpUpdates", () => {
  it("returns the SAME array reference when no live updates exist", () => {
    const cohort = makeFixtureCohort();
    const merged = mergeHpUpdates(cohort, new Map());
    expect(merged).toBe(cohort);
  });

  it("returns the SAME array reference when live updates match the polled values exactly", () => {
    const cohort = makeFixtureCohort();
    const target = cohort[0]!;
    const updates = new Map<string, HpUpdate>([
      [target.token.toLowerCase(), {
        hp: target.hp,
        components: {
          ...target.components,
          holderConcentration: 0.5, // present on the live shape but not in TokenResponse
        },
        weightsVersion: "v",
        computedAt: 1_700_000_000,
        trigger: "BLOCK_TICK",
        receivedAtIso: new Date().toISOString(),
      }],
    ]);
    const merged = mergeHpUpdates(cohort, updates);
    expect(merged).toBe(cohort);
  });

  it("overlays HP + components onto the matching token", () => {
    const cohort = makeFixtureCohort();
    const target = cohort[0]!;
    const updates = new Map<string, HpUpdate>([
      [target.token.toLowerCase(), {
        hp: 42,
        components: {
          velocity: 0.11,
          effectiveBuyers: 0.22,
          stickyLiquidity: 0.33,
          retention: 0.44,
          momentum: 0.55,
          holderConcentration: 0.66,
        },
        weightsVersion: "v",
        computedAt: 1_700_000_000,
        trigger: "SWAP",
        receivedAtIso: new Date().toISOString(),
      }],
    ]);
    const merged = mergeHpUpdates(cohort, updates);
    expect(merged[0]!.hp).toBe(42);
    expect(merged[0]!.components.velocity).toBe(0.11);
    // rank/ticker/status unchanged — merger only touches HP + components.
    expect(merged[0]!.rank).toBe(target.rank);
    expect(merged[0]!.ticker).toBe(target.ticker);
    expect(merged[0]!.status).toBe(target.status);
  });

  it("preserves React identity for unaffected rows so memoized children don't re-render", () => {
    const cohort = makeFixtureCohort();
    const target = cohort[0]!;
    const updates = new Map<string, HpUpdate>([
      [target.token.toLowerCase(), {
        hp: 99,
        components: {
          velocity: 0.1, effectiveBuyers: 0.2, stickyLiquidity: 0.3,
          retention: 0.4, momentum: 0.5, holderConcentration: 0.6,
        },
        weightsVersion: "v", computedAt: 1, trigger: "SWAP",
        receivedAtIso: new Date().toISOString(),
      }],
    ]);
    const merged = mergeHpUpdates(cohort, updates);
    // First row was overwritten — fresh object.
    expect(merged[0]).not.toBe(cohort[0]);
    // Unaffected rows are reference-equal.
    expect(merged[1]).toBe(cohort[1]);
    expect(merged[5]).toBe(cohort[5]);
  });
});

describe("freshHpUpdateSeqByAddress", () => {
  const NOW = Date.parse("2026-05-03T10:30:00.000Z");

  it("returns the computedAt seq for addresses inside the recency window", () => {
    const updates = new Map<string, HpUpdate>([
      ["fresh", {
        hp: 1, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 1_700_000_010, trigger: "SWAP",
        receivedAtIso: new Date(NOW - 1_000).toISOString(),
      }],
      ["stale", {
        hp: 1, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 1_700_000_005, trigger: "SWAP",
        receivedAtIso: new Date(NOW - 10_000).toISOString(),
      }],
    ]);
    const seqs = freshHpUpdateSeqByAddress(updates, 3_000, NOW);
    expect(seqs.get("fresh")).toBe(1_700_000_010);
    expect(seqs.has("stale")).toBe(false);
  });

  it("changes the seq for a token when a newer HP_UPDATED arrives — drives animation replay (bugbot M PR #83)", () => {
    const t1 = NOW - 2_500;
    const t2 = NOW - 100;
    const first = new Map<string, HpUpdate>([
      ["x", {
        hp: 50, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 1_700_000_001, trigger: "SWAP",
        receivedAtIso: new Date(t1).toISOString(),
      }],
    ]);
    const second = new Map<string, HpUpdate>([
      ["x", {
        hp: 60, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 1_700_000_002, trigger: "SWAP",
        receivedAtIso: new Date(t2).toISOString(),
      }],
    ]);
    const seq1 = freshHpUpdateSeqByAddress(first, 3_000, NOW);
    const seq2 = freshHpUpdateSeqByAddress(second, 3_000, NOW);
    // Both windows are "fresh" but the seq value is different — the
    // leaderboard uses this as a React key, so a different value forces
    // the wrapper to remount and replay the CSS animation.
    expect(seq1.get("x")).toBe(1_700_000_001);
    expect(seq2.get("x")).toBe(1_700_000_002);
    expect(seq1.get("x")).not.toBe(seq2.get("x"));
  });

  it("returns a stable empty map when the input map is empty", () => {
    const a = freshHpUpdateSeqByAddress(new Map(), 3_000, NOW);
    const b = freshHpUpdateSeqByAddress(new Map(), 3_000, NOW);
    expect(a).toBe(b);
    expect(a.size).toBe(0);
  });

  it("treats malformed timestamps as not-recent rather than throwing", () => {
    const updates = new Map<string, HpUpdate>([
      ["bad", {
        hp: 1, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 0, trigger: "SWAP",
        receivedAtIso: "not-a-date",
      }],
    ]);
    expect(() => freshHpUpdateSeqByAddress(updates, 3_000, NOW)).not.toThrow();
    expect(freshHpUpdateSeqByAddress(updates, 3_000, NOW).size).toBe(0);
  });
});
