/// Tests for the live HP overlay derived from the SSE stream — Epic 1.17c.
///
/// Pure-function coverage: the hook just folds events into a Map; the merger
/// applies the overlay to a polled cohort; recentlyUpdatedAddresses reads
/// the receivedAt timestamps. No DOM / hooks runtime needed for the merger
/// + helpers — they're pure. The hook itself is a thin useMemo wrapper, so
/// we exercise it via the renderHook seam.

import {renderHook} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {
  mergeHpUpdates,
  recentlyUpdatedAddresses,
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
  it("returns an empty map when no HP_UPDATED events are present", () => {
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
    const {result} = renderHook(() => useHpUpdates(events));
    expect(result.current.hpByAddress.size).toBe(0);
  });

  it("captures the freshest HP_UPDATED per token (by computedAt)", () => {
    const events: TickerEvent[] = [
      // Newest-first (matches useTickerEvents buffer order).
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
      // Out-of-order: same token, older computedAt — must NOT clobber the fresh one.
      hpUpdatedEvent({id: 3, address: TOKEN_A, data: fakeHpData({hp: 70, computedAt: 1_700_000_001})}),
    ];
    const {result} = renderHook(() => useHpUpdates(events));
    expect(result.current.hpByAddress.get(TOKEN_A.toLowerCase())!.hp).toBe(90);
  });

  it("skips HP_UPDATED frames missing the address field", () => {
    const events: TickerEvent[] = [
      hpUpdatedEvent({id: 1, address: TOKEN_A, data: fakeHpData()}),
      // Address null — system-scoped HP_UPDATED isn't a current shape, but the
      // type permits it; the hook must not crash.
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
});

describe("mergeHpUpdates", () => {
  it("returns a clone of the cohort when there are no live updates", () => {
    const cohort = makeFixtureCohort();
    const merged = mergeHpUpdates(cohort, new Map());
    expect(merged).toHaveLength(cohort.length);
    expect(merged[0]).toBe(cohort[0]); // empty map fast-path returns slice; identity preserved per row
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
        weightsVersion: "v", computedAt: 1n as unknown as number, trigger: "SWAP",
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

  it("returns the SAME row reference when the live frame matches the polled HP exactly", () => {
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
    expect(merged[0]).toBe(cohort[0]);
  });
});

describe("recentlyUpdatedAddresses", () => {
  const NOW = Date.parse("2026-05-03T10:30:00.000Z");

  it("returns addresses whose receivedAt is within the recency window", () => {
    const updates = new Map<string, HpUpdate>([
      ["fresh", {
        hp: 1, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 0, trigger: "SWAP",
        receivedAtIso: new Date(NOW - 1_000).toISOString(),
      }],
      ["stale", {
        hp: 1, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 0, trigger: "SWAP",
        receivedAtIso: new Date(NOW - 10_000).toISOString(),
      }],
    ]);
    const fresh = recentlyUpdatedAddresses(updates, 3_000, NOW);
    expect(fresh.has("fresh")).toBe(true);
    expect(fresh.has("stale")).toBe(false);
  });

  it("treats malformed timestamps as not-recent rather than throwing", () => {
    const updates = new Map<string, HpUpdate>([
      ["bad", {
        hp: 1, components: {} as HpUpdatedData["components"], weightsVersion: "v",
        computedAt: 0, trigger: "SWAP",
        receivedAtIso: "not-a-date",
      }],
    ]);
    expect(() => recentlyUpdatedAddresses(updates, 3_000, NOW)).not.toThrow();
    expect(recentlyUpdatedAddresses(updates, 3_000, NOW).size).toBe(0);
  });
});
