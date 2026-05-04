/// Epic 1.18 — composite HP integer scale + tie-break smoke tests.
///
/// Pin the post-1.18 contract:
///   - `score()` returns integer HP in `[HP_MIN, HP_MAX]` (= [0, 10000])
///   - `hpToInt` rounds half-up (Math.round for positives) — Track E's
///     Python pipeline uses `int(weighted_sum * 10000 + 0.5)` to match
///   - sort key is `(hp DESC, launchedAt ASC)` — earlier-launched wins on
///     ties; missing `launchedAt` falls through to stable order
///   - `HP_WEIGHTS_VERSION` reflects the `-int10k` bump
///   - `HP_COMPOSITE_SCALE` exposes the canonical scale for /scoring/weights

import {describe, expect, it} from "vitest";

import {
  HP_COMPOSITE_SCALE,
  HP_MAX,
  HP_MIN,
  HP_WEIGHTS_VERSION,
  hpToInt,
  score,
  type Address,
  type TokenStats,
} from "../src/index.js";

const tokenA = "0x000000000000000000000000000000000000000a" as Address;
const tokenB = "0x000000000000000000000000000000000000000b" as Address;
const tokenC = "0x000000000000000000000000000000000000000c" as Address;

const wallet = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;

const NOW = 10_000_000n;
const WETH = 1_000_000_000_000_000_000n;

function makeStats(
  overrides: Partial<TokenStats> & Pick<TokenStats, "token">,
): TokenStats {
  return {
    volumeByWallet: new Map(),
    buys: [],
    sells: [],
    liquidityDepthWeth: 0n,
    currentHolders: new Set(),
    holdersAtRetentionAnchor: new Set(),
    ...overrides,
  };
}

describe("Epic 1.18 — composite scale", () => {
  it("HP_COMPOSITE_SCALE is the canonical int [0, 10000] scale", () => {
    expect(HP_COMPOSITE_SCALE).toEqual({min: 0, max: 10000, type: "integer"});
    expect(HP_MIN).toBe(0);
    expect(HP_MAX).toBe(10000);
  });

  it("HP_WEIGHTS_VERSION reflects the int10k bump", () => {
    expect(HP_WEIGHTS_VERSION).toBe("2026-05-05-v4-locked-int10k");
  });

  it("hpToInt rounds half-up at the boundary", () => {
    // 0.42345 × 10000 = 4234.5 → Math.round → 4235 (rounds half toward +∞)
    expect(hpToInt(0.42345)).toBe(4235);
    // 0.42344 × 10000 = 4234.4 → 4234
    expect(hpToInt(0.42344)).toBe(4234);
    // 0.42355 × 10000 = 4235.5 → 4236
    expect(hpToInt(0.42355)).toBe(4236);
  });

  it("hpToInt clamps NaN / out-of-range defensively", () => {
    expect(hpToInt(Number.NaN)).toBe(0);
    expect(hpToInt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(hpToInt(-1)).toBe(0);
    expect(hpToInt(0)).toBe(0);
    expect(hpToInt(1)).toBe(10000);
    expect(hpToInt(2)).toBe(10000);
  });

  it("score() returns integer HP in [0, 10000] for every cohort row", () => {
    // Stress with a varied cohort — assert every row's HP is an integer in
    // the canonical range. Property-style: deterministic seeded inputs so a
    // failure is reproducible.
    const cohort: TokenStats[] = [];
    for (let i = 0; i < 25; i++) {
      const w = wallet(i + 1);
      cohort.push(
        makeStats({
          token: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
          volumeByWallet: new Map([[w, WETH * BigInt(i + 1)]]),
          buys: [{wallet: w, ts: NOW - BigInt(60 * (i + 1)), amountWeth: WETH * BigInt(i + 1)}],
          liquidityDepthWeth: WETH * BigInt((i + 1) * 2),
          currentHolders: new Set([w]),
          holdersAtRetentionAnchor: new Set([w]),
          launchedAt: NOW - BigInt(3600 * (i + 1)),
        }),
      );
    }
    const ranked = score(cohort, NOW);
    expect(ranked.length).toBe(25);
    for (const r of ranked) {
      expect(Number.isInteger(r.hp)).toBe(true);
      expect(r.hp).toBeGreaterThanOrEqual(HP_MIN);
      expect(r.hp).toBeLessThanOrEqual(HP_MAX);
    }
  });
});

describe("Epic 1.18 — launchedAt tie-break", () => {
  it("two tokens at exactly equal HP — earlier launchedAt ranks higher", () => {
    // Identical metrics → identical normalized components → identical HP.
    // Only `launchedAt` differs.
    const w = wallet(1);
    const baseHolders = new Set([w]);
    const buys = [{wallet: w, ts: NOW - 100n, amountWeth: WETH}];
    const earlier = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[w, WETH]]),
      buys,
      liquidityDepthWeth: WETH,
      currentHolders: baseHolders,
      holdersAtRetentionAnchor: baseHolders,
      launchedAt: NOW - 7200n, // launched 2h ago
    });
    const later = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[w, WETH]]),
      buys,
      liquidityDepthWeth: WETH,
      currentHolders: baseHolders,
      holdersAtRetentionAnchor: baseHolders,
      launchedAt: NOW - 3600n, // launched 1h ago
    });
    const ranked = score([later, earlier], NOW);
    // Same HP — no rounding gap, just identical inputs.
    expect(ranked[0]?.hp).toBe(ranked[1]?.hp);
    // Earlier-launched wins regardless of input order.
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[1]?.token).toBe(tokenB);
    expect(ranked[1]?.rank).toBe(2);

    // Reverse the input order — same outcome.
    const ranked2 = score([earlier, later], NOW);
    expect(ranked2[0]?.token).toBe(tokenA);
    expect(ranked2[1]?.token).toBe(tokenB);
  });

  it("non-tied HP wins regardless of launchedAt order", () => {
    // Strong distributed cohort: HP A > HP B even though A launched LATER.
    const wA = wallet(1);
    const wB = wallet(2);
    const strong = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wA, WETH * 10n]]),
      buys: [{wallet: wA, ts: NOW - 100n, amountWeth: WETH * 10n}],
      liquidityDepthWeth: WETH * 10n,
      currentHolders: new Set([wA]),
      holdersAtRetentionAnchor: new Set([wA]),
      launchedAt: NOW - 60n, // launched 60s ago — much later
    });
    const weak = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wB, WETH / 10n]]),
      buys: [{wallet: wB, ts: NOW - 100n, amountWeth: WETH / 10n}],
      liquidityDepthWeth: WETH / 10n,
      currentHolders: new Set([wB]),
      holdersAtRetentionAnchor: new Set([wB]),
      launchedAt: NOW - 86400n, // launched 24h ago — much earlier
    });
    const ranked = score([weak, strong], NOW);
    // HP wins; launchedAt is only consulted on ties.
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[1]?.token).toBe(tokenB);
  });

  it("missing launchedAt: tie falls through to stable input order", () => {
    // Two identical tokens, neither carries launchedAt → Array.sort stable
    // preserves the input order. This is the "degenerate cohort" path —
    // production rows always carry launchedAt.
    const w = wallet(1);
    const buys = [{wallet: w, ts: NOW - 100n, amountWeth: WETH}];
    const a = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[w, WETH]]),
      buys,
      liquidityDepthWeth: WETH,
      currentHolders: new Set([w]),
      holdersAtRetentionAnchor: new Set([w]),
    });
    const b = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[w, WETH]]),
      buys,
      liquidityDepthWeth: WETH,
      currentHolders: new Set([w]),
      holdersAtRetentionAnchor: new Set([w]),
    });
    const ranked = score([a, b], NOW);
    expect(ranked[0]?.hp).toBe(ranked[1]?.hp);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[1]?.token).toBe(tokenB);
  });

  it("3-way tie — all earlier-launched tokens rank above any later-launched", () => {
    // A, B, C all identical except for launchedAt: B earliest, A middle, C latest.
    const w = wallet(1);
    const buys = [{wallet: w, ts: NOW - 100n, amountWeth: WETH}];
    const baseHolders = new Set([w]);
    const mk = (token: Address, launchedAt: bigint): TokenStats =>
      makeStats({
        token,
        volumeByWallet: new Map([[w, WETH]]),
        buys,
        liquidityDepthWeth: WETH,
        currentHolders: baseHolders,
        holdersAtRetentionAnchor: baseHolders,
        launchedAt,
      });
    const ranked = score(
      [mk(tokenA, NOW - 7200n), mk(tokenB, NOW - 14400n), mk(tokenC, NOW - 3600n)],
      NOW,
    );
    expect(ranked[0]?.token).toBe(tokenB); // earliest
    expect(ranked[1]?.token).toBe(tokenA); // middle
    expect(ranked[2]?.token).toBe(tokenC); // latest
  });

  it("property-style: random component scores producing ties always rank earlier-launched first", () => {
    // Seeded LCG so failures are reproducible. We construct pairs of tokens
    // whose normalized component scores end up identical (same wallet, same
    // buys, same LP, same holders) but different launchedAt — every pair
    // must satisfy the tie-break invariant.
    let seed = 0xdeadbeef;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let trial = 0; trial < 50; trial++) {
      const buyAmt = WETH + BigInt(Math.floor(rand() * 1_000_000_000_000_000));
      const lpAmt = WETH + BigInt(Math.floor(rand() * 5_000_000_000_000_000));
      const w = wallet(trial + 100);
      const baseHolders = new Set([w]);
      const buys = [{wallet: w, ts: NOW - BigInt(60 + Math.floor(rand() * 1000)), amountWeth: buyAmt}];
      const earlierAt = NOW - BigInt(7200 + Math.floor(rand() * 86400));
      const laterAt = earlierAt + BigInt(60 + Math.floor(rand() * 7200));
      const earlier = makeStats({
        token: tokenA,
        volumeByWallet: new Map([[w, buyAmt]]),
        buys,
        liquidityDepthWeth: lpAmt,
        currentHolders: baseHolders,
        holdersAtRetentionAnchor: baseHolders,
        launchedAt: earlierAt,
      });
      const later = makeStats({
        token: tokenB,
        volumeByWallet: new Map([[w, buyAmt]]),
        buys,
        liquidityDepthWeth: lpAmt,
        currentHolders: baseHolders,
        holdersAtRetentionAnchor: baseHolders,
        launchedAt: laterAt,
      });
      const ranked = score([later, earlier], NOW);
      expect(ranked[0]?.hp).toBe(ranked[1]?.hp);
      expect(ranked[0]?.token).toBe(tokenA);
      expect(ranked[0]?.rank).toBe(1);
    }
  });
});

describe("Epic 1.18 — known-input → expected integer HP", () => {
  it("a single-token retention-only cohort produces a deterministic HP", () => {
    // No prior history → momentum = 0 (default flags). Single-token cohort →
    // velocity / effectiveBuyers / stickyLiq all min-max to 0 (only value in
    // cohort). Retention = 1.0 from the holder set. holderConcentration = 0
    // (no holderBalances supplied).
    //
    // HP = w_retention × 1.0 = 0.15
    // → integer HP = round(0.15 × 10000) = 1500
    const w = wallet(1);
    const t = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[w, WETH]]),
      buys: [{wallet: w, ts: NOW - 100n, amountWeth: WETH}],
      liquidityDepthWeth: WETH,
      currentHolders: new Set([w]),
      holdersAtRetentionAnchor: new Set([w]),
      launchedAt: NOW - 3600n,
    });
    const ranked = score([t], NOW);
    expect(ranked[0]?.hp).toBe(1500);
  });

  it("a fully distributed cohort vs a baseline produces ~9370 (matches v4 reference)", () => {
    // 30 wallets, deep LP, full retention, well-distributed holders.
    const buys = Array.from({length: 30}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 100n,
      amountWeth: WETH,
    }));
    const holders = new Set(buys.map((b) => b.wallet));
    const distributed = makeStats({
      token: tokenA,
      volumeByWallet: new Map(buys.map((b) => [b.wallet, b.amountWeth])),
      buys,
      liquidityDepthWeth: 50n * WETH,
      avgLiquidityDepthWeth: 50n * WETH,
      currentHolders: holders,
      holdersAtRetentionAnchor: holders,
      holderBalances: Array.from({length: 30}, () => 100n),
      launchedAt: NOW - 86400n,
    });
    const baseline = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(999), WETH / 100n]]),
      buys: [{wallet: wallet(999), ts: NOW - 100n, amountWeth: WETH / 100n}],
      liquidityDepthWeth: WETH,
      avgLiquidityDepthWeth: WETH,
      currentHolders: new Set([wallet(999)]),
      holdersAtRetentionAnchor: new Set([wallet(999)]),
      holderBalances: [1_000_000n],
      launchedAt: NOW - 100n,
    });
    const ranked = score([distributed, baseline], NOW);
    const r = ranked.find((s) => s.token === tokenA)!;
    // Reference HP under v4 weights ≈ 0.937 → int10k ≈ 9370 ± rounding.
    expect(r.hp).toBeGreaterThanOrEqual(9300);
    expect(r.hp).toBeLessThanOrEqual(9450);
    expect(Number.isInteger(r.hp)).toBe(true);
  });
});
