import * as components from "./components.js";
import {
  COMPONENT_LABELS,
  DEFAULT_CONFIG,
  DEFAULT_FLAGS,
  HP_MAX,
  HP_MIN,
  HP_WEIGHTS_VERSION,
  LOCKED_WEIGHTS,
  type Address,
  type ScoredToken,
  type ScoringConfig,
  type ScoringWeights,
  type TokenStats,
  type WeightFlags,
  weightsForPhase,
} from "./types.js";

/// Computes the v4-locked composite HP for each token in the cohort.
///
/// HP = w_velocity            * velocity
///    + w_effectiveBuyers     * effectiveBuyers
///    + w_stickyLiquidity     * stickyLiquidity
///    + w_retention           * retention
///    + w_momentum            * momentum               (gated by flags.momentum)
///    + w_holderConcentration * holderConcentration    (gated by flags.concentration)
///
/// Velocity / effective-buyers / sticky-liquidity are min-max normalized
/// across the cohort; retention + holderConcentration are already in [0, 1]
/// by construction; momentum is bounded in [0, momentumCap].
///
/// **Feature flags.** When `flags.momentum === false` the momentum component
/// short-circuits to 0 *without* invoking `computeMomentumComponent` (so a
/// test can spy on the boundary and assert no compute happened). When
/// `flags.concentration === false` the holderConcentration coefficient is
/// excluded and the remaining five weights are renormalized to sum to 1.0,
/// preserving HP ∈ [0, 1].
///
/// Pure function — caller supplies `currentTime` so output is reproducible
/// (matters for the oracle's Merkle root).
export function score(
  tokens: ReadonlyArray<TokenStats>,
  currentTime: bigint,
  config: ScoringConfig = DEFAULT_CONFIG,
): ScoredToken[] {
  if (tokens.length === 0) return [];

  const flags: WeightFlags = config.flags ?? DEFAULT_FLAGS;
  const baseWeights: ScoringWeights = config.weights ?? weightsForPhase(config.phase);
  const effectiveWeights = applyFlagsToWeights(baseWeights, flags);

  // 1. Raw component values per token. Velocity / effective-buyers /
  //    sticky-liquidity are unbounded — normalized below. Retention and
  //    holderConcentration are already in [0, 1].
  const raw = tokens.map((t) => ({
    token: t.token,
    velocity: computeVelocity(t, currentTime, config),
    effectiveBuyers: computeEffectiveBuyers(t, config),
    stickyLiquidity: computeStickyLiquidity(t, config),
    retention: computeRetention(t, config),
    holderConcentration: flags.concentration ? components.computeHolderConcentration(t) : 0,
    priorBaseComposite: t.priorBaseComposite,
    launchedAt: t.launchedAt,
  }));

  // 2. Normalize unbounded components.
  // Retention + holderConcentration are NOT min-maxed: a "100% retention"
  // or "perfectly distributed" cohort shouldn't be reset to 0 just because
  // every token shares the same value.
  const normVel = normalizeMinMax(raw.map((r) => r.velocity));
  const normBuy = normalizeMinMax(raw.map((r) => r.effectiveBuyers));
  const normLiq = normalizeMinMax(raw.map((r) => r.stickyLiquidity));

  // The non-momentum weight share — used to renormalize the baseComposite
  // back into [0, 1] regardless of the configured momentum weight, so the
  // baseComposite stays comparable across configurations even after flags
  // shift the active weight set.
  const nonMomentumSum =
    effectiveWeights.velocity +
    effectiveWeights.effectiveBuyers +
    effectiveWeights.stickyLiquidity +
    effectiveWeights.retention +
    effectiveWeights.holderConcentration;

  const scored = raw.map((r, i) => {
    const v = normVel[i] ?? 0;
    const b = normBuy[i] ?? 0;
    const l = normLiq[i] ?? 0;
    const ret = clamp01(r.retention);
    const hc = clamp01(r.holderConcentration);

    const baseComposite =
      nonMomentumSum > 0
        ? (effectiveWeights.velocity * v +
            effectiveWeights.effectiveBuyers * b +
            effectiveWeights.stickyLiquidity * l +
            effectiveWeights.retention * ret +
            effectiveWeights.holderConcentration * hc) /
          nonMomentumSum
        : 0;

    // Momentum: gated by HP_MOMENTUM_ENABLED. The flag-off path returns 0
    // without invoking `computeMomentumComponent` so a spy at the boundary
    // can assert the compute path was skipped. Flag-on path runs the full
    // calculation against `priorBaseComposite`.
    const momentum = flags.momentum
      ? components.computeMomentumComponent(r.priorBaseComposite, baseComposite, config)
      : 0;

    const weightedSum =
      effectiveWeights.velocity * v +
      effectiveWeights.effectiveBuyers * b +
      effectiveWeights.stickyLiquidity * l +
      effectiveWeights.retention * ret +
      effectiveWeights.momentum * momentum +
      effectiveWeights.holderConcentration * hc;

    return {
      token: r.token,
      // Scale to integer [HP_MIN, HP_MAX]. Round-half-up (Math.round for
      // positives) — Track E's Python pipeline mirrors this with
      // `int(weighted_sum * 10000 + 0.5)` so off-chain replays land on the
      // same integer.
      hp: hpToInt(weightedSum),
      // Stash launchedAt internally for the tie-break sort — stripped from
      // the returned shape via destructuring below so consumers see only the
      // public ScoredToken contract.
      _launchedAt: r.launchedAt,
      phase: config.phase,
      baseComposite,
      weightsVersion: HP_WEIGHTS_VERSION,
      flagsActive: flags,
      components: {
        velocity: {
          score: v,
          weight: effectiveWeights.velocity,
          label: COMPONENT_LABELS.velocity,
        },
        effectiveBuyers: {
          score: b,
          weight: effectiveWeights.effectiveBuyers,
          label: COMPONENT_LABELS.effectiveBuyers,
        },
        stickyLiquidity: {
          score: l,
          weight: effectiveWeights.stickyLiquidity,
          label: COMPONENT_LABELS.stickyLiquidity,
        },
        retention: {
          score: ret,
          weight: effectiveWeights.retention,
          label: COMPONENT_LABELS.retention,
        },
        momentum: {
          score: momentum,
          weight: effectiveWeights.momentum,
          label: COMPONENT_LABELS.momentum,
        },
        holderConcentration: {
          score: hc,
          weight: effectiveWeights.holderConcentration,
          label: COMPONENT_LABELS.holderConcentration,
        },
      },
    };
  });

  // Spec §6.5 "Composite scale + tie-break": primary key is integer HP
  // descending; secondary key is launchedAt ascending (earlier wins). Without
  // the secondary key, two tokens at the same integer HP would resolve by
  // Array.sort's stable order — fine for replays of the same input but
  // ambiguous when the indexer reads cohorts back from the DB in a different
  // order. Tokens missing `launchedAt` fall through to the stable ordering;
  // production cohorts always carry it (joined from the `token` table).
  scored.sort((a, b) => {
    if (a.hp !== b.hp) return b.hp - a.hp;
    const aL = a._launchedAt;
    const bL = b._launchedAt;
    if (aL !== undefined && bL !== undefined && aL !== bL) {
      return aL < bL ? -1 : 1;
    }
    return 0;
  });
  return scored.map((s, idx) => {
    const publicShape: ScoredToken = {
      token: s.token,
      rank: idx + 1,
      hp: s.hp,
      phase: s.phase,
      baseComposite: s.baseComposite,
      weightsVersion: s.weightsVersion,
      flagsActive: s.flagsActive,
      components: s.components,
    };
    return publicShape;
  });
}

/// Convert a [0, 1] weighted sum into the integer [HP_MIN, HP_MAX] composite
/// scale. Round-half-up via `Math.round` (rounds half toward +∞ for positive
/// inputs). Track E's Python pipeline mirrors this with
/// `int(weighted_sum * 10000 + 0.5)` so a row scored on-chain matches its
/// retrospective Track E recompute exactly.
///
/// Out-of-range / NaN inputs clamp to `[HP_MIN, HP_MAX]` defensively — a
/// negative weighted sum can only arise if a future component returns a
/// negative score, which would itself be a bug, but the clamp keeps the
/// integer-storage invariant intact regardless.
export function hpToInt(weightedSum01: number): number {
  if (!Number.isFinite(weightedSum01)) return HP_MIN;
  const clamped = Math.max(0, Math.min(1, weightedSum01));
  return Math.max(HP_MIN, Math.min(HP_MAX, Math.round(clamped * HP_MAX)));
}

/// Applies feature flags to a weight set. Inactive components zero out;
/// active components renormalize so the total sum is preserved (preserves
/// HP ∈ [0, 1] for any base weight set, not just LOCKED_WEIGHTS).
///
/// - `flags.momentum === false` → zero momentum's weight (in addition to
///   the score short-circuit in `score`). This guarantees
///   `flagsActive.momentum:false` rows have momentum.weight = 0 in the
///   stamped breakdown, so consumers reading historical rows can see that
///   the gate was off without ambiguity.
/// - `flags.concentration === false` → zero holderConcentration's weight.
///
/// Renormalization runs once over the *active* subset after both gates have
/// applied. **PR #71 bugbot caught a stacking bug** in the prior two-pass
/// implementation: when both flags were off and `base.momentum > 0`, the
/// concentration-off renormalization scaled to the post-momentum-zeroed
/// sum rather than the original total, so the final weights summed to
/// `1.0 - base.momentum` instead of 1.0. Harmless under LOCKED_WEIGHTS
/// (momentum = 0 in v4) but the function is publicly exported and the
/// docstring promises sum-preservation for any caller. The squash-merge
/// of #71 dropped the original fix commit; re-applying here in 1.17b.
/// Compute the active subset once, scale to `baseSum` in a single pass.
export function applyFlagsToWeights(
  base: ScoringWeights,
  flags: WeightFlags,
): ScoringWeights {
  const baseSum =
    base.velocity +
    base.effectiveBuyers +
    base.stickyLiquidity +
    base.retention +
    base.momentum +
    base.holderConcentration;

  const active: ScoringWeights = {
    velocity: base.velocity,
    effectiveBuyers: base.effectiveBuyers,
    stickyLiquidity: base.stickyLiquidity,
    retention: base.retention,
    momentum: flags.momentum ? base.momentum : 0,
    holderConcentration: flags.concentration ? base.holderConcentration : 0,
  };
  const activeSum =
    active.velocity +
    active.effectiveBuyers +
    active.stickyLiquidity +
    active.retention +
    active.momentum +
    active.holderConcentration;
  if (activeSum <= 0 || activeSum === baseSum) return active;
  const scale = baseSum / activeSum;
  return {
    velocity: active.velocity * scale,
    effectiveBuyers: active.effectiveBuyers * scale,
    stickyLiquidity: active.stickyLiquidity * scale,
    retention: active.retention * scale,
    momentum: active.momentum * scale,
    holderConcentration: active.holderConcentration * scale,
  };
}

/// Decayed net buy inflow with sybil dampening + churn discount.
///
/// - Each buy contributes its WETH amount × `2^(-age/halfLife)` (recency).
/// - Each sell subtracts the same way; sells that fall within `churnWindowSec`
///   of a same-wallet buy are doubled (pump-and-dump signal).
/// - Per-wallet net is clamped at 0.
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
function computeStickyLiquidity(t: TokenStats, config: ScoringConfig): number {
  const avg = t.avgLiquidityDepthWeth ?? t.liquidityDepthWeth;
  const avgF = bigintToFloat(avg);
  if (avgF <= 0) return 0;
  const removedF = bigintToFloat(t.recentLiquidityRemovedWeth ?? 0n);
  const penalty = (removedF / avgF) * config.recentWithdrawalPenalty;
  return Math.max(0, avgF * (1 - Math.min(1, penalty)));
}

/// Two-anchor retention: `long` for conviction, `short` so a token bleeding
/// fresh holders can't coast on day-old stickiness.
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

// Re-export the component helpers so `index.ts` can surface them at the
// package boundary.
export {computeHolderConcentration, computeMomentumComponent} from "./components.js";

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
  return Number(b);
}

// Re-export for convenience (tests + boundary code spy on these).
export {LOCKED_WEIGHTS, HP_WEIGHTS_VERSION};
