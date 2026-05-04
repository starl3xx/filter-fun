/// Tests for the HP projection — Epic 1.22b.
///
/// `tokenStatsFromRows` is a pure function that takes pre-fetched indexer
/// slices and produces a `TokenStats` for the scoring engine. Vitest can't
/// drive Ponder's Drizzle context directly (the writer-side path is exercised
/// via the integration tests), but the projection itself is sync + side-
/// effect-free, so we drive it with synthetic inputs here.
///
/// Coverage:
///   - trade aggregation: volumeByWallet sums BUY swaps; buys/sells streams
///     preserve order + per-event metadata
///   - holder projection: balance > 0 only; holderBalances includes every
///     active holder; totalSupply = sum of balances; firstSeenAt populated
///   - retention anchor: holders with firstSeenAt ≤ T-24h land in the long
///     anchor; the short anchor (T-1h) is independent
///   - empty cohort: degenerate inputs produce a coherent zero-shaped stats
///
/// The integration-flavor tests (real DB rows → projection → score) are in
/// `handlers.test.ts` against the `ApiQueries` adapter.

import {describe, expect, it} from "vitest";

import {
  RETENTION_LONG_SEC,
  RETENTION_SHORT_SEC,
  tokenStatsFromRows,
  type TokenProjectionInputs,
} from "../../src/api/hp.js";
import type {Address} from "@filter-fun/scoring";

const TOKEN = "0x000000000000000000000000000000000000000a" as `0x${string}`;
const W1 = "0x0000000000000000000000000000000000000001" as `0x${string}`;
const W2 = "0x0000000000000000000000000000000000000002" as `0x${string}`;
const W3 = "0x0000000000000000000000000000000000000003" as `0x${string}`;

const NOW = 1_700_000_000n;

function row(over: Partial<{liquidationProceeds: bigint | null; createdAt: bigint}> = {}) {
  return {
    id: TOKEN,
    liquidationProceeds: null,
    createdAt: NOW - 7n * 24n * 3600n,
    ...over,
  };
}

describe("tokenStatsFromRows — trade aggregation", () => {
  it("sums BUY wethValue per wallet into volumeByWallet", () => {
    const proj: TokenProjectionInputs = {
      swaps: [
        {taker: W1, side: "BUY", wethValue: 100n, blockTimestamp: NOW - 3600n},
        {taker: W1, side: "BUY", wethValue: 200n, blockTimestamp: NOW - 1800n},
        {taker: W2, side: "BUY", wethValue: 50n, blockTimestamp: NOW - 60n},
        {taker: W2, side: "SELL", wethValue: 30n, blockTimestamp: NOW - 30n},
      ],
      holders: [],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.volumeByWallet.get(W1.toLowerCase() as Address)).toBe(300n);
    expect(stats.volumeByWallet.get(W2.toLowerCase() as Address)).toBe(50n);
  });

  it("partitions buys + sells streams correctly", () => {
    const proj: TokenProjectionInputs = {
      swaps: [
        {taker: W1, side: "BUY", wethValue: 10n, blockTimestamp: NOW - 100n},
        {taker: W1, side: "SELL", wethValue: 5n, blockTimestamp: NOW - 50n},
        {taker: W2, side: "BUY", wethValue: 20n, blockTimestamp: NOW - 25n},
      ],
      holders: [],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.buys).toHaveLength(2);
    expect(stats.sells).toHaveLength(1);
    expect(stats.buys[0]).toMatchObject({
      wallet: W1.toLowerCase(),
      ts: NOW - 100n,
      amountWeth: 10n,
    });
    expect(stats.sells[0]).toMatchObject({
      wallet: W1.toLowerCase(),
      ts: NOW - 50n,
      amountWeth: 5n,
    });
  });

  it("normalizes wallet addresses to lowercase", () => {
    const proj: TokenProjectionInputs = {
      swaps: [
        {
          taker: "0x000000000000000000000000000000000000ABCD" as `0x${string}`,
          side: "BUY",
          wethValue: 1n,
          blockTimestamp: NOW,
        },
      ],
      holders: [],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.volumeByWallet.get("0x000000000000000000000000000000000000abcd" as Address)).toBe(
      1n,
    );
  });
});

describe("tokenStatsFromRows — holder projection", () => {
  it("excludes holders with balance ≤ 0; balance > 0 lands in currentHolders + holderBalances", () => {
    const proj: TokenProjectionInputs = {
      swaps: [],
      holders: [
        {holder: W1, balance: 100n, firstSeenAt: NOW - 100n},
        {holder: W2, balance: 0n, firstSeenAt: NOW - 200n},
        {holder: W3, balance: 50n, firstSeenAt: NOW - 300n},
      ],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.currentHolders.size).toBe(2);
    expect(stats.currentHolders.has(W1.toLowerCase() as Address)).toBe(true);
    expect(stats.currentHolders.has(W3.toLowerCase() as Address)).toBe(true);
    expect(stats.holderBalances).toEqual([100n, 50n]);
    expect(stats.totalSupply).toBe(150n);
  });

  it("populates holderFirstSeenAt for active holders", () => {
    const proj: TokenProjectionInputs = {
      swaps: [],
      holders: [{holder: W1, balance: 1n, firstSeenAt: NOW - 7n * 24n * 3600n}],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.holderFirstSeenAt?.get(W1.toLowerCase() as Address)).toBe(
      NOW - 7n * 24n * 3600n,
    );
  });

  it("returns undefined fields when no holders are present (engine-graceful empty)", () => {
    const proj: TokenProjectionInputs = {swaps: [], holders: []};
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.currentHolders.size).toBe(0);
    expect(stats.holderBalances).toEqual([]);
    expect(stats.totalSupply).toBeUndefined();
    expect(stats.holderFirstSeenAt).toBeUndefined();
    expect(stats.holderBalancesAtRetentionAnchor).toBeUndefined();
  });
});

describe("tokenStatsFromRows — retention anchor", () => {
  it("long anchor includes holders with firstSeenAt ≤ now - 24h", () => {
    const oneDay = RETENTION_LONG_SEC;
    const proj: TokenProjectionInputs = {
      swaps: [],
      holders: [
        {holder: W1, balance: 1n, firstSeenAt: NOW - oneDay - 1n}, // qualifies
        {holder: W2, balance: 1n, firstSeenAt: NOW - oneDay + 1n}, // misses
        {holder: W3, balance: 1n, firstSeenAt: NOW - 100n * 3600n}, // qualifies
      ],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.holdersAtRetentionAnchor.size).toBe(2);
    expect(stats.holdersAtRetentionAnchor.has(W1.toLowerCase() as Address)).toBe(true);
    expect(stats.holdersAtRetentionAnchor.has(W3.toLowerCase() as Address)).toBe(true);
    expect(stats.holdersAtRetentionAnchor.has(W2.toLowerCase() as Address)).toBe(false);
  });

  it("short anchor (1h) is independent of the long anchor (24h)", () => {
    const proj: TokenProjectionInputs = {
      swaps: [],
      holders: [
        {holder: W1, balance: 1n, firstSeenAt: NOW - RETENTION_SHORT_SEC - 1n}, // short ✓
        {holder: W2, balance: 1n, firstSeenAt: NOW - RETENTION_LONG_SEC - 1n}, // both ✓
        {holder: W3, balance: 1n, firstSeenAt: NOW - 60n}, // neither
      ],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    // Long anchor: only W2.
    expect(stats.holdersAtRetentionAnchor.size).toBe(1);
    expect(stats.holdersAtRetentionAnchor.has(W2.toLowerCase() as Address)).toBe(true);
    // Short anchor: W1 + W2.
    expect(stats.holdersAtRecentAnchor?.size).toBe(2);
    expect(stats.holdersAtRecentAnchor?.has(W1.toLowerCase() as Address)).toBe(true);
    expect(stats.holdersAtRecentAnchor?.has(W2.toLowerCase() as Address)).toBe(true);
  });

  it("populates holderBalancesAtRetentionAnchor for long-anchor holders", () => {
    const proj: TokenProjectionInputs = {
      swaps: [],
      holders: [
        {holder: W1, balance: 7n, firstSeenAt: NOW - RETENTION_LONG_SEC - 100n}, // qualifies
        {holder: W2, balance: 99n, firstSeenAt: NOW - 60n}, // doesn't
      ],
    };
    const stats = tokenStatsFromRows(row(), proj, NOW);
    expect(stats.holderBalancesAtRetentionAnchor?.size).toBe(1);
    expect(stats.holderBalancesAtRetentionAnchor?.get(W1.toLowerCase() as Address)).toBe(7n);
    expect(stats.holderBalancesAtRetentionAnchor?.get(W2.toLowerCase() as Address)).toBeUndefined();
  });
});

describe("tokenStatsFromRows — empty cohort", () => {
  it("produces a coherent stats shape with no swaps and no holders", () => {
    const stats = tokenStatsFromRows(row(), {swaps: [], holders: []}, NOW);
    expect(stats.token).toBe(TOKEN);
    expect(stats.volumeByWallet.size).toBe(0);
    expect(stats.buys).toEqual([]);
    expect(stats.sells).toEqual([]);
    expect(stats.currentHolders.size).toBe(0);
    expect(stats.holdersAtRetentionAnchor.size).toBe(0);
    expect(stats.liquidityDepthWeth).toBe(0n);
    // launchedAt should propagate from the TokenRow regardless of inputs.
    expect(stats.launchedAt).toBe(NOW - 7n * 24n * 3600n);
  });
});
