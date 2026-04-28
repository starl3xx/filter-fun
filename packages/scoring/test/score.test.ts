import {describe, it, expect} from "vitest";
import {score, type Address, type TokenStats, DEFAULT_CONFIG} from "../src/index.js";

const tokenA = "0x000000000000000000000000000000000000000a" as Address;
const tokenB = "0x000000000000000000000000000000000000000b" as Address;
const tokenC = "0x000000000000000000000000000000000000000c" as Address;

const wallet = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;

const NOW = 1_000_000n;

function makeStats(overrides: Partial<TokenStats> & Pick<TokenStats, "token">): TokenStats {
  return {
    volumeByWallet: new Map(),
    buys: [],
    liquidityDepthUsdc: 0n,
    currentHolders: new Set(),
    holdersAtRetentionAnchor: new Set(),
    ...overrides,
  };
}

describe("score", () => {
  it("ranks the token with stronger metrics higher", () => {
    const a = makeStats({
      token: tokenA,
      volumeByWallet: new Map([
        [wallet(1), 1_000_000n],
        [wallet(2), 1_000_000n],
        [wallet(3), 1_000_000n],
      ]),
      buys: [
        {wallet: wallet(1), ts: NOW - 100n, amountUsdc: 1_000_000n},
        {wallet: wallet(2), ts: NOW - 100n, amountUsdc: 1_000_000n},
        {wallet: wallet(3), ts: NOW - 100n, amountUsdc: 1_000_000n},
      ],
      liquidityDepthUsdc: 5_000_000n,
      currentHolders: new Set([wallet(1), wallet(2), wallet(3)]),
      holdersAtRetentionAnchor: new Set([wallet(1), wallet(2), wallet(3)]),
    });
    const b = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(4), 100_000n]]),
      buys: [{wallet: wallet(4), ts: NOW - 100n, amountUsdc: 100_000n}],
      liquidityDepthUsdc: 500_000n,
      currentHolders: new Set([wallet(4)]),
      holdersAtRetentionAnchor: new Set([wallet(4)]),
    });

    const ranked = score([a, b], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[1]?.token).toBe(tokenB);
    expect(ranked[0]?.rank).toBe(1);
  });

  it("dampens whale effects via per-wallet log-cap", () => {
    // Two tokens with equal raw volume. tokenA: distributed across 10 wallets. tokenB: one whale.
    const aBuys = Array.from({length: 10}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 100n,
      amountUsdc: 100_000n,
    }));
    const aVolume = new Map(aBuys.map((b) => [b.wallet, b.amountUsdc]));
    const a = makeStats({
      token: tokenA,
      volumeByWallet: aVolume,
      buys: aBuys,
      liquidityDepthUsdc: 1_000_000n,
      currentHolders: new Set(aBuys.map((b) => b.wallet)),
      holdersAtRetentionAnchor: new Set(aBuys.map((b) => b.wallet)),
    });
    const b = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(99), 1_000_000n]]),
      buys: [{wallet: wallet(99), ts: NOW - 100n, amountUsdc: 1_000_000n}],
      liquidityDepthUsdc: 1_000_000n,
      currentHolders: new Set([wallet(99)]),
      holdersAtRetentionAnchor: new Set([wallet(99)]),
    });

    const ranked = score([a, b], NOW);
    // Distributed-volume token should outrank whale-volume token.
    expect(ranked[0]?.token).toBe(tokenA);
  });

  it("decays older buys", () => {
    // Same volume + buyer count, only the timestamp differs.
    const fresh = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), 1_000_000n]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountUsdc: 1_000_000n}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const stale = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(2), 1_000_000n]]),
      buys: [
        // 5 half-lives older
        {wallet: wallet(2), ts: NOW - BigInt(5 * DEFAULT_CONFIG.velocityHalfLifeSec), amountUsdc: 1_000_000n},
      ],
      currentHolders: new Set([wallet(2)]),
      holdersAtRetentionAnchor: new Set([wallet(2)]),
    });

    const ranked = score([fresh, stale], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
  });

  it("retention component reflects holder churn", () => {
    // Same volume profile; only retention differs.
    const sticky = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), 1_000n]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountUsdc: 1_000n}],
      currentHolders: new Set([wallet(1), wallet(2), wallet(3)]),
      holdersAtRetentionAnchor: new Set([wallet(1), wallet(2), wallet(3)]),
    });
    const churning = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(1), 1_000n]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountUsdc: 1_000n}],
      currentHolders: new Set([wallet(99)]),
      holdersAtRetentionAnchor: new Set([wallet(1), wallet(2), wallet(3)]),
    });

    const ranked = score([sticky, churning], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[0]?.components.retention).toBe(1);
    expect(ranked[1]?.components.retention).toBe(0);
  });

  it("returns empty for empty input", () => {
    expect(score([], NOW)).toEqual([]);
  });

  it("handles single-token cohort with all-zero normalization", () => {
    const onlyOne = makeStats({
      token: tokenC,
      volumeByWallet: new Map([[wallet(1), 1_000n]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountUsdc: 1_000n}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const ranked = score([onlyOne], NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.rank).toBe(1);
    // Single-token cohort: every component normalizes to 0 (no spread to compare against)
    // — composite is 0. Still a valid leaderboard.
    expect(ranked[0]?.score).toBe(0);
  });
});
