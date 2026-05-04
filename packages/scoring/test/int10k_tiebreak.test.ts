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
    expect(HP_WEIGHTS_VERSION).toBe("2026-05-04-v4-locked-int10k-formulas");
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
    // Both tokens must be ≥ 1h old so the §6.9 slot-fairness ageFactor
    // saturates to 1.0 — otherwise the older token's retention ageFactor
    // can dominate even when the younger has stronger raw metrics.
    const wA = wallet(1);
    const wB = wallet(2);
    const strong = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wA, WETH * 10n]]),
      buys: [{wallet: wA, ts: NOW - 100n, amountWeth: WETH * 10n}],
      liquidityDepthWeth: WETH * 10n,
      currentHolders: new Set([wA]),
      holdersAtRetentionAnchor: new Set([wA]),
      launchedAt: NOW - 7200n, // launched 2h ago — later, but ageFactor saturates
    });
    const weak = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wB, WETH / 10n]]),
      buys: [{wallet: wB, ts: NOW - 100n, amountWeth: WETH / 10n}],
      liquidityDepthWeth: WETH / 10n,
      currentHolders: new Set([wB]),
      holdersAtRetentionAnchor: new Set([wB]),
      launchedAt: NOW - 86400n, // launched 24h ago — earlier, ageFactor saturated
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
    // whose inputs are byte-identical (so under fixed-reference §6.7 their
    // component scores are identical to within float precision) but with
    // different launchedAt — every pair must satisfy the tie-break.
    //
    // Both `launchedAt` values must be ≥ 1h before NOW so the §6.9
    // slot-fairness ageFactor saturates to 1.0 (otherwise the earlier and
    // later tokens have different ageFactors and HP scores diverge).
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
      const earlierAt = NOW - BigInt(86400 + Math.floor(rand() * 86400));
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

describe("Epic 1.22 — known-input → expected integer HP (fixed-reference)", () => {
  it("a single-token retention-only cohort produces a deterministic HP", () => {
    // Pure-retention input: no buys, no LP, no holderBalances. ageFactor
    // saturates with launchedAt ≥ 1h before NOW. Under §6.7 fixed-reference
    // velocity / effectiveBuyers / stickyLiquidity all return 0 (no inputs);
    // retention sits at 1.0. v4 default flags → momentum 0, concentration on
    // (returns 0 without holderBalances).
    //
    // HP = w_retention × 1.0 = 0.15 → integer HP = round(0.15 × 10000) = 1500.
    const w = wallet(1);
    const t = makeStats({
      token: tokenA,
      currentHolders: new Set([w]),
      holdersAtRetentionAnchor: new Set([w]),
      launchedAt: NOW - 24n * 3600n,
    });
    const ranked = score([t], NOW);
    expect(ranked[0]?.hp).toBe(1500);
  });

  it("a token whose raw values exceed every §6.7 reference saturates near 1.0", () => {
    // Inputs scaled comfortably above each reference (`VELOCITY_REFERENCE`,
    // `EFFECTIVE_BUYERS_REFERENCE`, `STICKY_LIQUIDITY_REFERENCE`) so all
    // three normalized scores hit 1.0. Plus full retention and a well-
    // distributed holder set (HHI → low → score → 1.0). Under v4 locked
    // weights the composite saturates to ≈ 1.0 → ≈ 10000.
    const buys = Array.from({length: 200}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 60n,
      // 20 WETH per wallet — capped at VELOCITY_PER_WALLET_CAP_WETH = 10
      // — but eb_raw = 200 × sqrt(20) ≈ 894 > REF=191, sl_raw = 1000 > REF=67.
      amountWeth: 20n * WETH,
    }));
    const holders = new Set(buys.map((b) => b.wallet));
    const huge = makeStats({
      token: tokenA,
      volumeByWallet: new Map(buys.map((b) => [b.wallet, b.amountWeth])),
      buys,
      liquidityDepthWeth: 1000n * WETH,
      avgLiquidityDepthWeth: 1000n * WETH,
      currentHolders: holders,
      holdersAtRetentionAnchor: holders,
      holderBalances: Array.from({length: 200}, () => 100n),
      launchedAt: NOW - 24n * 3600n,
    });
    const ranked = score([huge], NOW);
    const r = ranked[0]!;
    // Velocity / effectiveBuyers / stickyLiquidity / retention all saturate
    // at 1.0; holderConcentration with 200 equal balances yields hc ≈ 0.575
    // (HHI = 50 per §41.5). HP ≈ 0.9575 → 9575. The ≥9500 floor confirms
    // the four §6.7 components saturate; pushing hc to 1.0 needs ~6000+
    // holders, which the broader fixture suite (Phase 3) covers.
    expect(r.hp).toBeGreaterThanOrEqual(9500);
    expect(r.hp).toBeLessThanOrEqual(10000);
    expect(Number.isInteger(r.hp)).toBe(true);
  });
});
