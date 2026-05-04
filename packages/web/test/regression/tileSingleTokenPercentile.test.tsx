/// Epic 1.19 — bugbot finding regression (PR #91, commit 2a5dce2).
///
/// `computeCohortPercentiles` previously used `denom = Math.max(1, n - 1)`,
/// which silently rounded N=1 to denom=1. The single token then received
/// sort-index 0 in every component's sorted list, producing `(0 / 1) * 100`
/// = 0% across all five mini-bars. The tile rendered fully empty bars
/// despite the token potentially having strong absolute scores.
///
/// Post-fix: a cohort of size 0 or 1 returns an empty map so the tile's
/// `MiniBarRow` falls through to its raw-score branch (`rawScore * 100`)
/// and renders the meaningful absolute number.
import {describe, expect, it} from "vitest";

import {computeCohortPercentiles} from "../../src/components/arena/ArenaTileGrid.js";
import type {HpUpdate} from "../../src/hooks/arena/useHpUpdates.js";
import type {TokenResponse} from "../../src/lib/arena/api.js";

const SOLO: TokenResponse = {
  token: "0x0000000000000000000000000000000000000007",
  ticker: "$SOLO",
  rank: 1,
  hp: 9000,
  status: "FINALIST",
  price: "0.0001",
  priceChange24h: 0,
  volume24h: "0",
  liquidity: "1000",
  holders: 100,
  components: {
    velocity: 0.95,
    effectiveBuyers: 0.9,
    stickyLiquidity: 0.85,
    retention: 0.8,
    momentum: 0.75,
  },
  bagLock: {isLocked: false, unlockTimestamp: null, creator: "0x0"} as TokenResponse["bagLock"],
};

const EMPTY_HP: ReadonlyMap<string, HpUpdate> = new Map();

describe("Epic 1.19 — computeCohortPercentiles handles small cohorts", () => {
  it("empty cohort returns an empty map", () => {
    const result = computeCohortPercentiles([], EMPTY_HP);
    expect(result.size).toBe(0);
  });

  it("single-token cohort returns an empty map (so the tile falls through to raw scores)", () => {
    // Pre-fix this returned `{<addr>: {velocity: 0, effectiveBuyers: 0,
    // stickyLiquidity: 0, retention: 0, holderConcentration: 0}}` — a
    // map present but populated entirely with zeros, which the tile then
    // honoured (rendering empty bars). Post-fix the map stays empty so
    // `cohortPercentilesForToken` lookup is undefined and the tile uses
    // `rawScore * 100` instead.
    const result = computeCohortPercentiles([SOLO], EMPTY_HP);
    expect(result.size).toBe(0);
  });

  it("two-token cohort still computes percentiles (smallest valid cohort for a percentile rank)", () => {
    const second: TokenResponse = {
      ...SOLO,
      token: "0x0000000000000000000000000000000000000008" as `0x${string}`,
      ticker: "$DUO",
      components: {
        ...SOLO.components,
        velocity: 0.1, // Lower than SOLO's 0.95 → ranks 0 vs SOLO's 1.
      },
    };
    const result = computeCohortPercentiles([SOLO, second], EMPTY_HP);
    expect(result.size).toBe(2);
    // SOLO's velocity is higher → it sorts to index 1 → percentile = (1/1)*100 = 100.
    // second's velocity is lower → it sorts to index 0 → percentile = (0/1)*100 = 0.
    expect(result.get(SOLO.token.toLowerCase())?.velocity).toBe(100);
    expect(result.get(second.token.toLowerCase())?.velocity).toBe(0);
  });
});
