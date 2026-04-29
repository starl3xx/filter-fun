import {describe, it, expect} from "vitest";

import {
  COMPONENT_LABELS,
  DEFAULT_CONFIG,
  FINALS_WEIGHTS,
  PRE_FILTER_WEIGHTS,
  score,
  type Address,
  type ScoringConfig,
  type TokenStats,
} from "../src/index.js";

const tokenA = "0x000000000000000000000000000000000000000a" as Address;
const tokenB = "0x000000000000000000000000000000000000000b" as Address;
const tokenC = "0x000000000000000000000000000000000000000c" as Address;

const wallet = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;

const NOW = 10_000_000n;

// 1 WETH (1e18) — used as the dollar-equivalent unit in tests so the
// dust floor (5e15) and per-wallet floor (1e15) sit well below normal trades.
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

function configWithPhase(phase: ScoringConfig["phase"]): ScoringConfig {
  return {...DEFAULT_CONFIG, phase};
}

describe("score (v2)", () => {
  it("returns empty for empty input", () => {
    expect(score([], NOW)).toEqual([]);
  });

  it("ranks the token with stronger metrics higher and exposes the breakdown", () => {
    const a = makeStats({
      token: tokenA,
      volumeByWallet: new Map([
        [wallet(1), WETH],
        [wallet(2), WETH],
        [wallet(3), WETH],
      ]),
      buys: [
        {wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH},
        {wallet: wallet(2), ts: NOW - 100n, amountWeth: WETH},
        {wallet: wallet(3), ts: NOW - 100n, amountWeth: WETH},
      ],
      liquidityDepthWeth: 5n * WETH,
      currentHolders: new Set([wallet(1), wallet(2), wallet(3)]),
      holdersAtRetentionAnchor: new Set([wallet(1), wallet(2), wallet(3)]),
    });
    const b = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(4), WETH / 10n]]),
      buys: [{wallet: wallet(4), ts: NOW - 100n, amountWeth: WETH / 10n}],
      liquidityDepthWeth: WETH / 2n,
      currentHolders: new Set([wallet(4)]),
      holdersAtRetentionAnchor: new Set([wallet(4)]),
    });

    const ranked = score([a, b], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[1]?.token).toBe(tokenB);
    expect(ranked[0]?.rank).toBe(1);

    // Each component carries score / weight / label for the UI.
    const c = ranked[0]!.components;
    expect(c.velocity.label).toBe(COMPONENT_LABELS.velocity);
    expect(c.effectiveBuyers.label).toBe(COMPONENT_LABELS.effectiveBuyers);
    expect(c.stickyLiquidity.label).toBe(COMPONENT_LABELS.stickyLiquidity);
    expect(c.retention.label).toBe(COMPONENT_LABELS.retention);
    expect(c.momentum.label).toBe(COMPONENT_LABELS.momentum);

    // Phase + base composite are surfaced for downstream consumers.
    expect(ranked[0]?.phase).toBe("preFilter");
    expect(ranked[0]?.baseComposite).toBeGreaterThan(0);
  });

  it("a single whale doesn't dominate HP — distributed buying wins", () => {
    // Distributed: 10 wallets each buying 1 WETH. Whale: 1 wallet buying 10 WETH.
    // Same gross volume, same liquidity, same retention. Whale wallet has the
    // log-cap kick in; distributed token effectively gets full per-wallet credit.
    const distributedBuys = Array.from({length: 10}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 100n,
      amountWeth: WETH,
    }));
    const distributed = makeStats({
      token: tokenA,
      volumeByWallet: new Map(distributedBuys.map((b) => [b.wallet, b.amountWeth])),
      buys: distributedBuys,
      liquidityDepthWeth: 10n * WETH,
      currentHolders: new Set(distributedBuys.map((b) => b.wallet)),
      holdersAtRetentionAnchor: new Set(distributedBuys.map((b) => b.wallet)),
    });
    const whale = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(99), 10n * WETH]]),
      buys: [{wallet: wallet(99), ts: NOW - 100n, amountWeth: 10n * WETH}],
      liquidityDepthWeth: 10n * WETH,
      currentHolders: new Set([wallet(99)]),
      holdersAtRetentionAnchor: new Set([wallet(99)]),
    });

    const ranked = score([distributed, whale], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    // Effective buyers for the distributed token should sit at the cohort max.
    expect(ranked[0]?.components.effectiveBuyers.score).toBe(1);
    expect(ranked[1]?.components.effectiveBuyers.score).toBe(0);
  });

  it("dust wallets do not inflate effective buyers", () => {
    // tokenA: 100 dust wallets (each below the dust floor) + zero liquidity.
    // tokenB: 5 wallets each buying well above the floor.
    // tokenB should dominate effective buyers despite far fewer wallets.
    const dustAmount = DEFAULT_CONFIG.buyerDustFloorWeth - 1n;
    const dustBuys = Array.from({length: 100}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 100n,
      amountWeth: dustAmount,
    }));
    const dustToken = makeStats({
      token: tokenA,
      volumeByWallet: new Map(dustBuys.map((b) => [b.wallet, b.amountWeth])),
      buys: dustBuys,
      liquidityDepthWeth: WETH,
      currentHolders: new Set(dustBuys.map((b) => b.wallet)),
      holdersAtRetentionAnchor: new Set(dustBuys.map((b) => b.wallet)),
    });
    const realBuys = Array.from({length: 5}, (_, i) => ({
      wallet: wallet(1000 + i),
      ts: NOW - 100n,
      amountWeth: WETH,
    }));
    const realToken = makeStats({
      token: tokenB,
      volumeByWallet: new Map(realBuys.map((b) => [b.wallet, b.amountWeth])),
      buys: realBuys,
      liquidityDepthWeth: WETH,
      currentHolders: new Set(realBuys.map((b) => b.wallet)),
      holdersAtRetentionAnchor: new Set(realBuys.map((b) => b.wallet)),
    });

    const ranked = score([dustToken, realToken], NOW);
    expect(ranked[0]?.token).toBe(tokenB);
    // Dust token has zero effective buyers — every wallet is below the floor.
    const dustRow = ranked.find((r) => r.token === tokenA)!;
    expect(dustRow.components.effectiveBuyers.score).toBe(0);
  });

  it("decays older buys", () => {
    // Same volume, same wallet count — only the timestamp differs.
    const fresh = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const stale = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(2), WETH]]),
      buys: [
        {
          wallet: wallet(2),
          ts: NOW - BigInt(5 * DEFAULT_CONFIG.velocityHalfLifeSec),
          amountWeth: WETH,
        },
      ],
      currentHolders: new Set([wallet(2)]),
      holdersAtRetentionAnchor: new Set([wallet(2)]),
    });

    const ranked = score([fresh, stale], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
  });

  it("retention reflects holder churn (long anchor only)", () => {
    const sticky = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1), wallet(2), wallet(3)]),
      holdersAtRetentionAnchor: new Set([wallet(1), wallet(2), wallet(3)]),
    });
    const churning = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(99)]),
      holdersAtRetentionAnchor: new Set([wallet(1), wallet(2), wallet(3)]),
    });

    const ranked = score([sticky, churning], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[0]?.components.retention.score).toBe(1);
    expect(ranked[1]?.components.retention.score).toBe(0);
  });

  it("retention combines long + short anchors when both are provided", () => {
    // Old holders fully retained, recent ones half retained → mixed score.
    const mixed = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1), wallet(2)]),
      holdersAtRetentionAnchor: new Set([wallet(1), wallet(2)]), // long: 100% retained
      holdersAtRecentAnchor: new Set([wallet(1), wallet(3)]),    // short: 50% retained
    });

    const ranked = score([mixed], NOW);
    const ret = ranked[0]!.components.retention.score;
    // long(1.0) * 0.6 + short(0.5) * 0.4 = 0.8
    expect(ret).toBeCloseTo(0.8, 5);
  });

  it("a dust buy after a pump-and-dump does not bypass churn detection", () => {
    // Attacker pattern: big buy → dump within churn window → tiny later buy
    // to "reset" the latest-buy pointer. The tiny later buy must NOT cancel
    // the churn discount on the earlier dump.
    const honest = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 1000n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const attacker = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(2), WETH + 1n]]),
      buys: [
        // Big initial buy
        {wallet: wallet(2), ts: NOW - 1000n, amountWeth: WETH},
        // Dust buy *after* the dump — would shift the latest-buy pointer
        // forward and trick a naive churn check.
        {wallet: wallet(2), ts: NOW - 500n, amountWeth: 1n},
      ],
      // Dump 90% of the initial buy 60s after buying — inside churn window.
      sells: [{wallet: wallet(2), ts: NOW - 940n, amountWeth: (WETH * 9n) / 10n}],
      currentHolders: new Set([wallet(2)]),
      holdersAtRetentionAnchor: new Set([wallet(2)]),
    });

    const ranked = score([honest, attacker], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[1]?.components.velocity.score).toBeLessThan(0.5);
  });

  it("net velocity discounts a wallet that buys then sells inside the churn window", () => {
    // Both tokens have one wallet buying 1 WETH. tokenA holds. tokenB sells
    // most of it inside the churn window — its velocity should crater.
    const hold = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const churn = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(2), WETH]]),
      buys: [{wallet: wallet(2), ts: NOW - 100n, amountWeth: WETH}],
      // Sell ~50% of the buy 60s after buying — well inside the 1h churn window.
      sells: [{wallet: wallet(2), ts: NOW - 40n, amountWeth: WETH / 2n}],
      currentHolders: new Set([wallet(2)]),
      holdersAtRetentionAnchor: new Set([wallet(2)]),
    });

    const ranked = score([hold, churn], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[0]?.components.velocity.score).toBe(1);
    expect(ranked[1]?.components.velocity.score).toBeLessThan(0.5);
  });

  it("recent LP withdrawal hurts sticky liquidity", () => {
    // Same average depth; tokenB has a large recent withdrawal.
    const stable = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      avgLiquidityDepthWeth: 100n * WETH,
      liquidityDepthWeth: 100n * WETH,
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const dumped = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      avgLiquidityDepthWeth: 100n * WETH,
      liquidityDepthWeth: 100n * WETH,
      // 50% of avg depth pulled recently → 25% haircut at default penalty 0.5.
      recentLiquidityRemovedWeth: 50n * WETH,
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });

    const ranked = score([stable, dumped], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    expect(ranked[0]?.components.stickyLiquidity.score).toBe(1);
    expect(ranked[1]?.components.stickyLiquidity.score).toBe(0);
  });

  it("a late surger gets a momentum boost but momentum cannot dominate", () => {
    // Two tokens with identical real metrics. Surger has a much lower prior
    // base composite — it surged. Coaster's prior matched this tick.
    const buys = [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}];
    const baseHolders = new Set([wallet(1)]);

    // Compute what this tick's base composite would be (single token is
    // always 0 due to min-max normalization, so put two together).
    const surger = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys,
      liquidityDepthWeth: WETH,
      currentHolders: baseHolders,
      holdersAtRetentionAnchor: baseHolders,
      priorBaseComposite: 0, // was nothing last tick
    });
    const coaster = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys,
      liquidityDepthWeth: WETH,
      currentHolders: baseHolders,
      holdersAtRetentionAnchor: baseHolders,
      priorBaseComposite: 1, // was already at the top last tick
    });

    const ranked = score([surger, coaster], NOW);
    const surgerRow = ranked.find((r) => r.token === tokenA)!;
    const coasterRow = ranked.find((r) => r.token === tokenB)!;
    expect(surgerRow.components.momentum.score).toBeGreaterThan(coasterRow.components.momentum.score);

    // Momentum's contribution is bounded by its weight (0.10 by default), so
    // the gap between surger HP and coaster HP can't exceed ~0.10.
    expect(Math.abs(surgerRow.hp - coasterRow.hp)).toBeLessThanOrEqual(
      DEFAULT_CONFIG.weights?.momentum ?? PRE_FILTER_WEIGHTS.momentum,
    );
  });

  it("momentum is neutral when no prior base composite is provided", () => {
    const t = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const ranked = score([t], NOW);
    expect(ranked[0]?.components.momentum.score).toBe(0.5);
  });

  it("phase weights change the ranking when components disagree", () => {
    // tokenA leads on velocity + effective buyers (six fresh distributed buys
    // but holders churned out — low retention). tokenB leads on sticky
    // liquidity + retention (huge LP, sticky holders) but is sleepy on
    // velocity. Pre-filter weights discovery → A wins. Finals weights
    // conviction → B wins.
    const aBuys = Array.from({length: 6}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 100n,
      amountWeth: WETH,
    }));
    const a = makeStats({
      token: tokenA,
      volumeByWallet: new Map(aBuys.map((b) => [b.wallet, b.amountWeth])),
      buys: aBuys,
      liquidityDepthWeth: WETH,
      avgLiquidityDepthWeth: WETH,
      // Buyers are present, but the original anchor cohort is gone — low retention.
      currentHolders: new Set(aBuys.map((b) => b.wallet)),
      holdersAtRetentionAnchor: new Set([wallet(900), wallet(901), wallet(902)]),
    });
    const stickyHolders = new Set([wallet(50), wallet(51), wallet(52), wallet(53)]);
    const b = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(99), WETH / 5n]]),
      buys: [{wallet: wallet(99), ts: NOW - 100n, amountWeth: WETH / 5n}],
      liquidityDepthWeth: 100n * WETH,
      avgLiquidityDepthWeth: 100n * WETH,
      // Same holders now as at the anchor — perfect retention.
      currentHolders: stickyHolders,
      holdersAtRetentionAnchor: stickyHolders,
    });

    const preFilter = score([a, b], NOW, configWithPhase("preFilter"));
    expect(preFilter[0]?.token).toBe(tokenA);

    const finals = score([a, b], NOW, configWithPhase("finals"));
    expect(finals[0]?.token).toBe(tokenB);

    // Sanity: weights actually flowed through.
    expect(preFilter[0]?.components.velocity.weight).toBe(PRE_FILTER_WEIGHTS.velocity);
    expect(finals[0]?.components.stickyLiquidity.weight).toBe(FINALS_WEIGHTS.stickyLiquidity);
  });

  it("a high-HP small-mcap token outranks a whale-pumped fat one", () => {
    // The "mcap" abstraction lives outside scoring — but the spirit of the
    // test: a whale-pumped token typically also has thin LP, recent LP exits,
    // and holders bleeding out, while a distributed token has broad buys +
    // sticky LP + sticky holders. The four-component composite punishes the
    // whale on every axis except raw velocity.
    const whaleToken = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(99), 100n * WETH]]),
      buys: [{wallet: wallet(99), ts: NOW - 100n, amountWeth: 100n * WETH}],
      // Thin LP and a fresh withdrawal — sticky liq tanks.
      liquidityDepthWeth: WETH,
      avgLiquidityDepthWeth: WETH,
      recentLiquidityRemovedWeth: WETH / 2n,
      currentHolders: new Set([wallet(99)]),
      // Anchor had four holders; only the whale remains — 25% retention.
      holdersAtRetentionAnchor: new Set([wallet(99), wallet(100), wallet(101), wallet(102)]),
    });

    const distributedBuys = Array.from({length: 30}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 100n,
      amountWeth: WETH,
    }));
    const distributedHolders = new Set(distributedBuys.map((b) => b.wallet));
    const distributedToken = makeStats({
      token: tokenB,
      volumeByWallet: new Map(distributedBuys.map((b) => [b.wallet, b.amountWeth])),
      buys: distributedBuys,
      liquidityDepthWeth: 50n * WETH,
      avgLiquidityDepthWeth: 50n * WETH,
      currentHolders: distributedHolders,
      holdersAtRetentionAnchor: distributedHolders,
    });

    const ranked = score([whaleToken, distributedToken], NOW);
    expect(ranked[0]?.token).toBe(tokenB);
  });

  it("handles single-token cohort gracefully", () => {
    const onlyOne = makeStats({
      token: tokenC,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      liquidityDepthWeth: WETH,
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const ranked = score([onlyOne], NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.rank).toBe(1);
    // Single-token cohort: min-max normalization → 0 for unbounded components,
    // retention still captures full conviction. Plus neutral momentum (0.5).
    // HP is therefore weights.retention * 1 + weights.momentum * 0.5.
    const w = PRE_FILTER_WEIGHTS;
    expect(ranked[0]?.hp).toBeCloseTo(w.retention + w.momentum * 0.5, 6);
  });
});
