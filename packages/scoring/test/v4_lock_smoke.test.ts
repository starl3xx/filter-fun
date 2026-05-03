/// V4 lock smoke tests — pin the on-the-wire behavior of the v4-locked
/// weights, the feature-flag defaults, and the holderConcentration component.
///
/// These tests are the trip-wires that catch silent drift on the locked
/// scoring path. If the operator changes weights without bumping
/// `HP_WEIGHTS_VERSION`, or the flag defaults flip without an env override,
/// the assertions here fail loud.

import {describe, expect, it, vi} from "vitest";

import * as components from "../src/components.js";
import {
  COMPONENT_LABELS,
  DEFAULT_CONFIG,
  DEFAULT_FLAGS,
  HP_WEIGHTS_ACTIVATED_AT,
  HP_WEIGHTS_VERSION,
  LOCKED_WEIGHTS,
  applyFlagsToWeights,
  computeHolderConcentration,
  flagsFromEnv,
  score,
  weightsForPhase,
  type Address,
  type ScoringConfig,
  type TokenStats,
} from "../src/index.js";

const tokenA = "0x000000000000000000000000000000000000000a" as Address;
const tokenB = "0x000000000000000000000000000000000000000b" as Address;

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

describe("v4 lock — version + activated-at provenance", () => {
  it("HP_WEIGHTS_VERSION is the locked-2026-05-03 sentinel", () => {
    expect(HP_WEIGHTS_VERSION).toBe("2026-05-03-v4-locked");
  });

  it("HP_WEIGHTS_ACTIVATED_AT pins activation timestamp", () => {
    expect(HP_WEIGHTS_ACTIVATED_AT).toBe("2026-05-03T00:00:00Z");
  });

  it("LOCKED_WEIGHTS values match Track E v4 final report", () => {
    expect(LOCKED_WEIGHTS.velocity).toBe(0.30);
    expect(LOCKED_WEIGHTS.effectiveBuyers).toBe(0.15);
    expect(LOCKED_WEIGHTS.stickyLiquidity).toBe(0.30);
    expect(LOCKED_WEIGHTS.retention).toBe(0.15);
    expect(LOCKED_WEIGHTS.momentum).toBe(0.0);
    expect(LOCKED_WEIGHTS.holderConcentration).toBe(0.10);
    const sum =
      LOCKED_WEIGHTS.velocity +
      LOCKED_WEIGHTS.effectiveBuyers +
      LOCKED_WEIGHTS.stickyLiquidity +
      LOCKED_WEIGHTS.retention +
      LOCKED_WEIGHTS.momentum +
      LOCKED_WEIGHTS.holderConcentration;
    expect(sum).toBeCloseTo(1, 9);
  });

  it("weightsForPhase returns LOCKED_WEIGHTS for both phases", () => {
    expect(weightsForPhase("preFilter")).toEqual(LOCKED_WEIGHTS);
    expect(weightsForPhase("finals")).toEqual(LOCKED_WEIGHTS);
  });

  it("ScoredToken stamps weightsVersion + flagsActive on every row", () => {
    const t = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
    });
    const ranked = score([t], NOW);
    expect(ranked[0]?.weightsVersion).toBe("2026-05-03-v4-locked");
    expect(ranked[0]?.flagsActive).toEqual(DEFAULT_FLAGS);
  });
});

describe("v4 lock — feature flag defaults + env parsing", () => {
  it("DEFAULT_FLAGS: momentum=false, concentration=true (per spec §6.4.5 + §41)", () => {
    expect(DEFAULT_FLAGS.momentum).toBe(false);
    expect(DEFAULT_FLAGS.concentration).toBe(true);
  });

  it("flagsFromEnv reads HP_MOMENTUM_ENABLED + HP_CONCENTRATION_ENABLED", () => {
    expect(flagsFromEnv({})).toEqual(DEFAULT_FLAGS);
    expect(flagsFromEnv({HP_MOMENTUM_ENABLED: "true"}).momentum).toBe(true);
    expect(flagsFromEnv({HP_CONCENTRATION_ENABLED: "false"}).concentration).toBe(false);
    // Common boolean spellings are handled.
    expect(flagsFromEnv({HP_MOMENTUM_ENABLED: "1"}).momentum).toBe(true);
    expect(flagsFromEnv({HP_MOMENTUM_ENABLED: "yes"}).momentum).toBe(true);
    expect(flagsFromEnv({HP_MOMENTUM_ENABLED: "on"}).momentum).toBe(true);
    expect(flagsFromEnv({HP_CONCENTRATION_ENABLED: "0"}).concentration).toBe(false);
    expect(flagsFromEnv({HP_CONCENTRATION_ENABLED: "off"}).concentration).toBe(false);
    // Garbage falls back to defaults.
    expect(flagsFromEnv({HP_MOMENTUM_ENABLED: "garbage"}).momentum).toBe(DEFAULT_FLAGS.momentum);
  });
});

describe("v4 lock — momentum flag gates the compute path", () => {
  it("flag-OFF returns 0 without calling computeMomentumComponent", () => {
    const spy = vi.spyOn(components, "computeMomentumComponent");
    const t = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
      priorBaseComposite: 0.5,
    });
    const ranked = score([t], NOW, {
      ...DEFAULT_CONFIG,
      flags: {momentum: false, concentration: true},
    });
    expect(ranked[0]?.components.momentum.score).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(ranked[0]?.flagsActive.momentum).toBe(false);
    spy.mockRestore();
  });

  it("flag-ON runs the full momentum computation", () => {
    const spy = vi.spyOn(components, "computeMomentumComponent");
    const t = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
      // Prior at 0 → any positive baseComposite produces a momentum signal.
      priorBaseComposite: 0,
    });
    const ranked = score([t], NOW, {
      ...DEFAULT_CONFIG,
      flags: {momentum: true, concentration: true},
    });
    expect(spy).toHaveBeenCalled();
    // Single-token retention-only cohort: baseComposite > 0 → delta > 0 →
    // momentum component sits in (0.5, 1.0] depending on `momentumScale`.
    expect(ranked[0]?.components.momentum.score).toBeGreaterThan(0.5);
    expect(ranked[0]?.flagsActive.momentum).toBe(true);
    spy.mockRestore();
  });
});

describe("v4 lock — concentration flag renormalizes remaining weights", () => {
  it("flag-OFF zeroes holderConcentration AND scales remaining weights to sum to 1.0", () => {
    const balances: bigint[] = Array.from({length: 50}, (_, i) => BigInt(100 + i));
    const t = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
      holderBalances: balances,
    });
    const ranked = score([t], NOW, {
      ...DEFAULT_CONFIG,
      flags: {momentum: false, concentration: false},
    });
    const c = ranked[0]!.components;
    expect(c.holderConcentration.score).toBe(0);
    expect(c.holderConcentration.weight).toBe(0);
    // Other weights renormalize so the active set sums to 1.0 (momentum is
    // also off → its weight is 0, but the renormalization redistributes the
    // dropped 0.10 across ALL non-concentration components proportionally).
    const total =
      c.velocity.weight +
      c.effectiveBuyers.weight +
      c.stickyLiquidity.weight +
      c.retention.weight +
      c.momentum.weight;
    expect(total).toBeCloseTo(1, 6);
    expect(ranked[0]?.flagsActive.concentration).toBe(false);
  });

  it("flag-ON computes HHI and weights it at 0.10", () => {
    // Pure-monopoly cohort: one wallet holds everything → HHI = 10000 → score = 0.
    const monopoly = makeStats({
      token: tokenA,
      volumeByWallet: new Map([[wallet(1), WETH]]),
      buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(1)]),
      holdersAtRetentionAnchor: new Set([wallet(1)]),
      holderBalances: [1_000_000n],
    });
    // Perfectly distributed cohort: 10 wallets, equal balance → HHI = 1000 → score = 0.25.
    const equalCount = 10;
    const distributed = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(2), WETH]]),
      buys: [{wallet: wallet(2), ts: NOW - 100n, amountWeth: WETH}],
      currentHolders: new Set([wallet(2)]),
      holdersAtRetentionAnchor: new Set([wallet(2)]),
      holderBalances: Array.from({length: equalCount}, () => 100n),
    });
    const ranked = score([monopoly, distributed], NOW);
    const monoRow = ranked.find((r) => r.token === tokenA)!;
    const distRow = ranked.find((r) => r.token === tokenB)!;
    expect(monoRow.components.holderConcentration.score).toBe(0);
    expect(distRow.components.holderConcentration.score).toBeCloseTo(0.25, 6);
    expect(distRow.components.holderConcentration.weight).toBe(0.10);
  });
});

describe("v4 lock — applyFlagsToWeights helper", () => {
  it("identity when both flags on", () => {
    expect(applyFlagsToWeights(LOCKED_WEIGHTS, {momentum: true, concentration: true}))
      .toEqual(LOCKED_WEIGHTS);
  });

  it("momentum-off zeroes momentum weight", () => {
    const w = applyFlagsToWeights(LOCKED_WEIGHTS, {momentum: false, concentration: true});
    expect(w.momentum).toBe(0);
    expect(w.holderConcentration).toBe(LOCKED_WEIGHTS.holderConcentration);
  });

  it("concentration-off renormalizes the rest to sum to baseSum", () => {
    const w = applyFlagsToWeights(LOCKED_WEIGHTS, {momentum: true, concentration: false});
    expect(w.holderConcentration).toBe(0);
    const sum = w.velocity + w.effectiveBuyers + w.stickyLiquidity + w.retention + w.momentum;
    expect(sum).toBeCloseTo(1, 6);
    // Proportions preserved: the velocity:effectiveBuyers ratio is unchanged.
    expect(w.velocity / w.effectiveBuyers).toBeCloseTo(
      LOCKED_WEIGHTS.velocity / LOCKED_WEIGHTS.effectiveBuyers,
      6,
    );
  });

  it("BOTH flags off + base.momentum > 0 still preserves baseSum (Bugbot PR #71 regression)", () => {
    // Bugbot caught a stacking bug in the prior two-pass implementation:
    // momentum-off zeroed momentum without renormalizing, then concentration-off
    // renormalized the post-zeroed set, so the final weights summed to
    // `baseSum - base.momentum` instead of baseSum. Harmless under
    // LOCKED_WEIGHTS (momentum = 0), but a custom set with non-zero momentum
    // would silently violate HP ∈ [0, 1]. The squash-merge of #71 dropped
    // the fix commit; re-applied in 1.17b. This test pins it.
    const customBase = {
      velocity: 0.35,
      effectiveBuyers: 0.20,
      stickyLiquidity: 0.20,
      retention: 0.10,
      momentum: 0.05, // <- non-zero — would be lost under the buggy two-pass
      holderConcentration: 0.10,
    };
    const w = applyFlagsToWeights(customBase, {momentum: false, concentration: false});
    expect(w.momentum).toBe(0);
    expect(w.holderConcentration).toBe(0);
    const sum =
      w.velocity + w.effectiveBuyers + w.stickyLiquidity + w.retention +
      w.momentum + w.holderConcentration;
    expect(sum).toBeCloseTo(1.0, 9);
    // Velocity:retention ratio preserved across the renormalization.
    expect(w.velocity / w.retention).toBeCloseTo(customBase.velocity / customBase.retention, 6);
  });

  it("BOTH flags off preserves baseSum even when baseSum != 1.0 (no implicit 1.0 target)", () => {
    // Defensive: callers may pass an unnormalized base. The function must
    // preserve whatever total the caller gave it, not silently clamp to 1.0.
    const unnormalizedBase = {
      velocity: 0.6,
      effectiveBuyers: 0.3,
      stickyLiquidity: 0.6,
      retention: 0.3,
      momentum: 0.0,
      holderConcentration: 0.2, // total = 2.0
    };
    const w = applyFlagsToWeights(unnormalizedBase, {momentum: false, concentration: false});
    const sum =
      w.velocity + w.effectiveBuyers + w.stickyLiquidity + w.retention +
      w.momentum + w.holderConcentration;
    expect(sum).toBeCloseTo(2.0, 9);
  });
});

describe("v4 lock — holderConcentration HHI reference points", () => {
  it("matches spec §41.5 reference points", () => {
    // HHI 10000 → score 0
    expect(
      computeHolderConcentration({...emptyStats(tokenA), holderBalances: [1n]}),
    ).toBe(0);
    // HHI 1 (perfectly atomized) → score 1. Approximated with 10000 equal balances.
    const atomized = Array.from({length: 10000}, () => 1n);
    expect(
      computeHolderConcentration({...emptyStats(tokenA), holderBalances: atomized}),
    ).toBeCloseTo(1.0, 4);
  });

  it("returns 0 for missing or empty holder data (safety)", () => {
    expect(computeHolderConcentration(emptyStats(tokenA))).toBe(0);
    expect(
      computeHolderConcentration({...emptyStats(tokenA), holderBalances: []}),
    ).toBe(0);
    expect(
      computeHolderConcentration({...emptyStats(tokenA), holderBalances: [0n, 0n]}),
    ).toBe(0);
  });
});

describe("v4 lock — reference input → expected HP", () => {
  // Two reference cases that pin the locked HP under default flags
  // (momentum=false, concentration=true). If LOCKED_WEIGHTS or the
  // component computations drift, these break.

  it("perfectly distributed token under the locked weights produces a high HP", () => {
    // 30 wallets each buying 1 WETH, deep LP, full retention, well-distributed.
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
    });
    // Comparison cohort needed for min-max normalization (single-token
    // cohort would zero unbounded components).
    const baseline = makeStats({
      token: tokenB,
      volumeByWallet: new Map([[wallet(999), WETH / 100n]]),
      buys: [{wallet: wallet(999), ts: NOW - 100n, amountWeth: WETH / 100n}],
      liquidityDepthWeth: WETH,
      avgLiquidityDepthWeth: WETH,
      currentHolders: new Set([wallet(999)]),
      holdersAtRetentionAnchor: new Set([wallet(999)]),
      holderBalances: [1_000_000n],
    });
    const ranked = score([distributed, baseline], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    const r = ranked.find((s) => s.token === tokenA)!;
    // Velocity 1, effectiveBuyers 1, stickyLiq 1, retention 1, hc ≈ log10(10000/3.33) / 4 ≈ ?
    // Hand-calc: HHI = 10000 × 30 × (1/30)² = 10000 / 30 ≈ 333.3 → score = 1 - log10(333.3)/4 ≈ 0.371.
    // HP under v4 weights = 0.30*1 + 0.15*1 + 0.30*1 + 0.15*1 + 0.0*0 + 0.10*0.371 ≈ 0.937.
    expect(r.hp).toBeGreaterThan(0.93);
    expect(r.hp).toBeLessThan(0.95);
    expect(r.weightsVersion).toBe(HP_WEIGHTS_VERSION);
  });

  it("monopoly-holder token loses the concentration term and ranks below distributed", () => {
    const honestBuys = Array.from({length: 30}, (_, i) => ({
      wallet: wallet(i + 1),
      ts: NOW - 100n,
      amountWeth: WETH,
    }));
    const honestHolders = new Set(honestBuys.map((b) => b.wallet));
    const honest = makeStats({
      token: tokenA,
      volumeByWallet: new Map(honestBuys.map((b) => [b.wallet, b.amountWeth])),
      buys: honestBuys,
      liquidityDepthWeth: 50n * WETH,
      avgLiquidityDepthWeth: 50n * WETH,
      currentHolders: honestHolders,
      holdersAtRetentionAnchor: honestHolders,
      holderBalances: Array.from({length: 30}, () => 100n),
    });
    const monopoly = makeStats({
      token: tokenB,
      volumeByWallet: new Map(honestBuys.map((b) => [b.wallet, b.amountWeth])),
      buys: honestBuys,
      liquidityDepthWeth: 50n * WETH,
      avgLiquidityDepthWeth: 50n * WETH,
      currentHolders: honestHolders,
      holdersAtRetentionAnchor: honestHolders,
      // Same activity profile, but ONE wallet holds 99.9% — concentration kills HP.
      holderBalances: [9990n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n],
    });
    const ranked = score([honest, monopoly], NOW);
    expect(ranked[0]?.token).toBe(tokenA);
    const honestRow = ranked.find((r) => r.token === tokenA)!;
    const monoRow = ranked.find((r) => r.token === tokenB)!;
    expect(honestRow.components.holderConcentration.score).toBeGreaterThan(
      monoRow.components.holderConcentration.score,
    );
    // The two tokens differ ONLY in concentration, so the HP gap exactly
    // equals 0.10 × (Δ score). With both at the cohort max on every other
    // axis, this is the cleanest end-to-end check that the new component
    // flows through HP.
    expect(honestRow.hp - monoRow.hp).toBeCloseTo(
      0.10 *
        (honestRow.components.holderConcentration.score -
          monoRow.components.holderConcentration.score),
      6,
    );
  });
});

function emptyStats(addr: Address): TokenStats {
  return {
    token: addr,
    volumeByWallet: new Map(),
    buys: [],
    sells: [],
    liquidityDepthWeth: 0n,
    currentHolders: new Set(),
    holdersAtRetentionAnchor: new Set(),
  };
}

// Unused-but-exposed type re-exports for compile-time anchor — the file
// asserts at the type level that ScoringConfig still has the legacy phase
// field (for future v5 revival per the wrapper contract).
type _ = ScoringConfig["phase"];
const _label = COMPONENT_LABELS.holderConcentration;
void _label;
