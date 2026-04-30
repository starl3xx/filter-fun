import {
  COMPONENT_LABELS,
  DEFAULT_CONFIG,
  type Address,
  type ScoredToken,
  type ScoringConfig,
  type ScoringWeights,
  type TokenStats,
  weightsForPhase,
} from "./types.js";

/// Computes the v3 composite HP for each token in the cohort.
///
/// HP = w_velocity * velocity
///    + w_effectiveBuyers * effectiveBuyers
///    + w_stickyLiquidity * stickyLiquidity
///    + w_retention * retention
///    + w_momentum * momentum
///
/// All five components are normalized to [0, 1] across the cohort. The final
/// HP is also in [0, 1] (since weights sum to 1). Pure function — caller
/// supplies `currentTime` so output is reproducible (matters for the oracle).
///
/// `priorBaseComposite` on each token is producer-managed state: store the
/// returned `baseComposite` and feed it back next tick to drive momentum.
export function score(
  tokens: ReadonlyArray<TokenStats>,
  currentTime: bigint,
  config: ScoringConfig = DEFAULT_CONFIG,
): ScoredToken[] {
  if (tokens.length === 0) return [];

  const weights: ScoringWeights = config.weights ?? weightsForPhase(config.phase);

  // 1. Raw component values per token.
  const raw = tokens.map((t) => ({
    token: t.token,
    velocity: computeVelocity(t, currentTime, config),
    effectiveBuyers: computeEffectiveBuyers(t, config),
    stickyLiquidity: computeStickyLiquidity(t, config),
    retention: computeRetention(t, config),
    priorBaseComposite: t.priorBaseComposite,
  }));

  // 2. Normalize the unbounded components across the cohort.
  // Retention is already in [0, 1] — we leave it alone so a "100% retention
  // across the board" doesn't get min-maxed back to 0; it stays maxed.
  const normVel = normalizeMinMax(raw.map((r) => r.velocity));
  const normBuy = normalizeMinMax(raw.map((r) => r.effectiveBuyers));
  const normLiq = normalizeMinMax(raw.map((r) => r.stickyLiquidity));

  // The non-momentum slice's weight share — used to renormalize the
  // baseComposite back into [0, 1] regardless of the configured momentum
  // weight. This keeps `baseComposite` comparable across configurations.
  const nonMomentumSum =
    weights.velocity + weights.effectiveBuyers + weights.stickyLiquidity + weights.retention;

  const scored = raw.map((r, i) => {
    const v = normVel[i] ?? 0;
    const b = normBuy[i] ?? 0;
    const l = normLiq[i] ?? 0;
    const ret = clamp01(r.retention);

    const baseComposite =
      nonMomentumSum > 0
        ? (weights.velocity * v +
            weights.effectiveBuyers * b +
            weights.stickyLiquidity * l +
            weights.retention * ret) /
          nonMomentumSum
        : 0;

    // Momentum compares this tick's base composite against the prior's. If
    // there's no prior (first tick), momentum is neutral 0.5 so a token can't
    // be punished for not having history yet — the cap is deliberately NOT
    // applied to the neutral baseline (operators tightening `momentumCap`
    // below 0.5 must not retroactively penalize tokens with zero history).
    // For tokens with a prior, the post-normalization momentum is clipped to
    // `momentumCap` so operators can bound momentum's contribution tighter
    // than the natural [0, weight] range produced by normalization.
    let momentum: number;
    if (typeof r.priorBaseComposite === "number") {
      const delta = baseComposite - r.priorBaseComposite;
      const clipped = Math.max(-1, Math.min(1, delta / config.momentumScale));
      momentum = Math.min((clipped + 1) / 2, config.momentumCap);
    } else {
      momentum = 0.5;
    }

    const hp =
      weights.velocity * v +
      weights.effectiveBuyers * b +
      weights.stickyLiquidity * l +
      weights.retention * ret +
      weights.momentum * momentum;

    return {
      token: r.token,
      hp,
      phase: config.phase,
      baseComposite,
      components: {
        velocity: {score: v, weight: weights.velocity, label: COMPONENT_LABELS.velocity},
        effectiveBuyers: {
          score: b,
          weight: weights.effectiveBuyers,
          label: COMPONENT_LABELS.effectiveBuyers,
        },
        stickyLiquidity: {
          score: l,
          weight: weights.stickyLiquidity,
          label: COMPONENT_LABELS.stickyLiquidity,
        },
        retention: {score: ret, weight: weights.retention, label: COMPONENT_LABELS.retention},
        momentum: {score: momentum, weight: weights.momentum, label: COMPONENT_LABELS.momentum},
      },
    };
  });

  scored.sort((a, b) => b.hp - a.hp);
  return scored.map((s, idx) => ({...s, rank: idx + 1}));
}

/// Decayed net buy inflow with sybil dampening + churn discount.
///
/// - Each buy contributes its WETH amount × `2^(-age/halfLife)` (recency).
/// - Each sell subtracts the same way; sells that fall within `churnWindowSec`
///   of a same-wallet buy are doubled (pump-and-dump signal).
/// - Per-wallet net is clamped at 0 (a wallet that exits net-negative doesn't
///   *help* HP — it just stops contributing).
/// - Per-wallet net is divided by `log2(1 + walletTotal/floor)`, so whales
///   contribute log-scaled rather than linearly.
function computeVelocity(t: TokenStats, now: bigint, config: ScoringConfig): number {
  const halfLife = config.velocityHalfLifeSec;
  const floor = bigintToFloat(config.walletCapFloorWeth);
  const churnWindow = BigInt(config.churnWindowSec);

  // All buy timestamps per wallet, sorted ascending. We can't store only the
  // latest: an attacker who buys, dumps within the churn window, then places
  // a tiny later buy would shift "latest" past the dump and bypass the
  // discount. Instead each sell looks up the latest buy that happened
  // *before or at* the sell time — a later buy can't reset the check.
  const buyTimestampsByWallet = new Map<Address, bigint[]>();
  for (const b of t.buys) {
    const arr = buyTimestampsByWallet.get(b.wallet);
    if (arr) arr.push(b.ts);
    else buyTimestampsByWallet.set(b.wallet, [b.ts]);
  }
  for (const arr of buyTimestampsByWallet.values()) {
    arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const buyDecayedByWallet = new Map<Address, number>();
  for (const buy of t.buys) {
    const age = Number(now - buy.ts);
    if (age < 0) continue;
    const decay = Math.pow(0.5, age / halfLife);
    const amt = bigintToFloat(buy.amountWeth) * decay;
    buyDecayedByWallet.set(buy.wallet, (buyDecayedByWallet.get(buy.wallet) ?? 0) + amt);
  }

  const sellDecayedByWallet = new Map<Address, number>();
  for (const sell of t.sells) {
    const age = Number(now - sell.ts);
    if (age < 0) continue;
    const decay = Math.pow(0.5, age / halfLife);

    // Latest same-wallet buy at or before this sell.
    const arr = buyTimestampsByWallet.get(sell.wallet);
    let lastBuyBeforeSell: bigint | null = null;
    if (arr) {
      for (const ts of arr) {
        if (ts > sell.ts) break;
        lastBuyBeforeSell = ts;
      }
    }
    const churn =
      lastBuyBeforeSell !== null && sell.ts - lastBuyBeforeSell <= churnWindow;
    const churnBoost = churn ? 2 : 1;

    const amt = bigintToFloat(sell.amountWeth) * decay * churnBoost;
    sellDecayedByWallet.set(sell.wallet, (sellDecayedByWallet.get(sell.wallet) ?? 0) + amt);
  }

  let total = 0;
  for (const [wallet, buyDec] of buyDecayedByWallet) {
    const sellDec = sellDecayedByWallet.get(wallet) ?? 0;
    const net = Math.max(0, buyDec - sellDec);
    if (net <= 0) continue;
    const walletTotal = bigintToFloat(t.volumeByWallet.get(wallet) ?? 0n);
    const cap = walletTotal > floor ? Math.log2(1 + walletTotal / floor) : 1;
    total += net / Math.max(cap, 1);
  }
  return total;
}

/// Effective buyers — sum of `f(walletBuyVolume)` across wallets above the
/// dust floor, where `f` is the configured dampening function (spec §6.4.2).
///
/// **sqrt (default).** Economic-significance weighted: 30 wallets at 1 WETH
/// produce 30 × √(1e18) ≈ 3.0e10, a single whale at 1000 WETH produces
/// √(1e21) ≈ 3.16e10 — the whale's commitment is roughly equivalent to 30
/// distributed buyers. Distributed buying still wins on headcount (and the
/// sybil dust floor still filters 1-wei swarms) but a real whale is not
/// completely flattened.
///
/// **log.** Heavy headcount preference: 30 × log(1e18) ≈ 1242 vs whale's
/// log(1e21) ≈ 48 — distributed dominates the whale by ~25×. Useful when
/// breadth is the entire signal.
///
/// Dust wallets (below `buyerDustFloorWeth`) contribute exactly zero —
/// filtered out before the formula is applied, so a sea of 1-wei sybils
/// does not produce any signal regardless of the chosen function.
function computeEffectiveBuyers(t: TokenStats, config: ScoringConfig): number {
  const dust = bigintToFloat(config.buyerDustFloorWeth);
  const dampen = config.effectiveBuyersFunc === "log"
    ? (v: number) => Math.log(1 + v)
    : (v: number) => Math.sqrt(v);
  let sum = 0;
  for (const vol of t.volumeByWallet.values()) {
    const v = bigintToFloat(vol);
    if (v < dust) continue;
    sum += dampen(v);
  }
  return sum;
}

/// Time-weighted sticky liquidity, with a recent-withdrawal penalty.
///
/// `avgLiquidityDepthWeth` is the trailing time-weighted average from the
/// indexer. If unset (genesis) we fall back to current depth.
/// `recentLiquidityRemovedWeth / avgDepth` × α (`recentWithdrawalPenalty`) is
/// the fractional haircut. With default α=1.0 (spec §6.4.3) a 100%-of-depth
/// recent withdrawal fully zeroes the score; a 50%-of-depth withdrawal
/// halves it.
///
/// **Indexer responsibility.** Protocol-controlled LP unwinds (filter-event
/// liquidations, settlement teardowns) are system actions, not market
/// signal — the indexer must exclude those tx hashes from
/// `recentLiquidityRemovedWeth` upstream of scoring. Scoring trusts whatever
/// is supplied; it cannot tell them apart on its own.
function computeStickyLiquidity(t: TokenStats, config: ScoringConfig): number {
  const avg = t.avgLiquidityDepthWeth ?? t.liquidityDepthWeth;
  const avgF = bigintToFloat(avg);
  if (avgF <= 0) return 0;
  const removedF = bigintToFloat(t.recentLiquidityRemovedWeth ?? 0n);
  const penalty = (removedF / avgF) * config.recentWithdrawalPenalty;
  return Math.max(0, avgF * (1 - Math.min(1, penalty)));
}

/// Two-anchor retention: `long` (e.g. 24h ago) for conviction, `short` (e.g.
/// 1h ago) so a token that's bleeding fresh holders can't coast on day-old
/// stickiness. Weighted by the configured long/short split.
function computeRetention(t: TokenStats, config: ScoringConfig): number {
  const longFrac = retentionFraction(t.holdersAtRetentionAnchor, t.currentHolders);
  if (!t.holdersAtRecentAnchor) return longFrac;
  const shortFrac = retentionFraction(t.holdersAtRecentAnchor, t.currentHolders);
  const lw = config.retentionLongWeight;
  const sw = config.retentionShortWeight;
  const total = lw + sw;
  return total > 0 ? (lw * longFrac + sw * shortFrac) / total : 0;
}

function retentionFraction(
  anchor: ReadonlySet<Address>,
  current: ReadonlySet<Address>,
): number {
  if (anchor.size === 0) return 0;
  let still = 0;
  for (const h of anchor) if (current.has(h)) still++;
  return still / anchor.size;
}

/// Min-max scale to [0, 1]. Uniform values map to 0 (no signal in this
/// component for this cohort).
function normalizeMinMax(values: number[]): number[] {
  if (values.length === 0) return [];
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return values.map(() => 0);
  return values.map((v) => (v - min) / range);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function bigintToFloat(b: bigint): number {
  // Lossy at very large magnitudes but fine for WETH-scale token volume.
  return Number(b);
}
