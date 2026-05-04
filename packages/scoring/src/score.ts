import * as components from "./components.js";
import {
  EFFECTIVE_BUYERS_DUST_WETH,
  EFFECTIVE_BUYERS_LOOKBACK_SEC,
  EFFECTIVE_BUYERS_REFERENCE,
  LP_PENALTY_TAU_SEC,
  LP_PENALTY_WINDOW_SEC,
  RETENTION_DUST_SUPPLY_FRAC,
  STICKY_LIQUIDITY_REFERENCE,
  VELOCITY_CHURN_PENALTY_FACTOR,
  VELOCITY_CHURN_WINDOW_SEC,
  VELOCITY_DECAY_HALFLIFE_SEC,
  VELOCITY_LOOKBACK_SEC,
  VELOCITY_PER_WALLET_CAP_WETH,
  VELOCITY_REFERENCE,
} from "./constants.js";
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
/// Per spec §6.7 (Epic 1.22 lock): velocity / effective-buyers /
/// sticky-liquidity are mapped to [0, 1] via fixed-reference constants
/// (`*_REFERENCE` calibrated from Track E v5), NOT min-max within the cohort.
/// This makes HP an ABSOLUTE signal — a token's score doesn't shift just
/// because peers improved. Retention + holderConcentration are already in
/// [0, 1] by construction; momentum is bounded in [0, momentumCap].
///
/// **Cohort percentile vs scoring.** The Arena tile view's mini-bars want a
/// within-cohort percentile (display only); production must compute that
/// separately on the API response (see `/season` schema in PR #45). Scoring
/// itself is cohort-invariant per §6.7.
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

  // Per-token raw component values. Velocity / effective-buyers /
  // sticky-liquidity are unbounded inputs to the fixed-reference mapping;
  // retention + holderConcentration are already [0, 1].
  const raw = tokens.map((t) => ({
    token: t.token,
    velocity: computeVelocityRaw(t, currentTime),
    effectiveBuyers: computeEffectiveBuyersRaw(t, currentTime),
    stickyLiquidity: computeStickyLiquidityRaw(t, currentTime, config),
    retention: computeRetention(t, currentTime, config),
    holderConcentration: flags.concentration ? components.computeHolderConcentration(t) : 0,
    priorBaseComposite: t.priorBaseComposite,
    launchedAt: t.launchedAt,
  }));

  // Fixed-reference normalization (§6.7). `min(1, raw / REFERENCE)` —
  // cohort-invariant. Reference values calibrated from Track E v5 cohort 90th
  // percentile; bumping requires a refit run (see Phase 4 of Epic 1.22).
  const normVel = raw.map((r) => clamp01(r.velocity / VELOCITY_REFERENCE));
  const normBuy = raw.map((r) => clamp01(r.effectiveBuyers / EFFECTIVE_BUYERS_REFERENCE));
  const normLiq = raw.map((r) => clamp01(r.stickyLiquidity / STICKY_LIQUIDITY_REFERENCE));

  // The non-momentum weight share — used to renormalize the baseComposite
  // back into [0, 1] regardless of the configured momentum weight.
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
      hp: hpToInt(weightedSum),
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

  // Spec §6.10 cohort-edge tie-break (Epic 1.22 lock):
  //   1. integer HP descending
  //   2. launchedAt ascending (earlier-launched wins on legitimacy)
  //   3. token address ascending lower-cased (deterministic last-resort)
  // Tier 3 was added in Epic 1.22 — the prior implementation fell through
  // to Array.sort's stable order, which is implementation-defined when the
  // indexer reads cohorts back from the DB in a different row order across
  // replicas. With three tiers the ordering is fully deterministic.
  scored.sort((a, b) => {
    if (a.hp !== b.hp) return b.hp - a.hp;
    const aL = a._launchedAt;
    const bL = b._launchedAt;
    if (aL !== undefined && bL !== undefined && aL !== bL) {
      return aL < bL ? -1 : 1;
    }
    const aAddr = a.token.toLowerCase();
    const bAddr = b.token.toLowerCase();
    if (aAddr < bAddr) return -1;
    if (aAddr > bAddr) return 1;
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
export function hpToInt(weightedSum01: number): number {
  if (!Number.isFinite(weightedSum01)) return HP_MIN;
  const clamped = Math.max(0, Math.min(1, weightedSum01));
  return Math.max(HP_MIN, Math.min(HP_MAX, Math.round(clamped * HP_MAX)));
}

/// Applies feature flags to a weight set. Inactive components zero out;
/// active components renormalize so the total sum is preserved (preserves
/// HP ∈ [0, 1] for any base weight set, not just LOCKED_WEIGHTS).
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

/// Velocity raw value — decayed net buy inflow with sybil dampening + churn
/// discount. Spec §6.4.1 (locked 2026-05-04).
///
/// Per the locked formula:
///   1. Drop buys/sells older than `VELOCITY_LOOKBACK_SEC` (96h hard cutoff).
///   2. Decay weight: `0.5 ^ (age / VELOCITY_DECAY_HALFLIFE_SEC)` (24h half-life).
///   3. Per-wallet net = max(0, decayed_buys − decayed_sells).
///   4. Sells within `VELOCITY_CHURN_WINDOW_SEC` of a same-wallet buy get
///      `× VELOCITY_CHURN_PENALTY_FACTOR` (pump-and-dump signal).
///   5. Per-wallet net is capped at `VELOCITY_PER_WALLET_CAP_WETH` (absolute
///      WETH cap — anti-whale).
///   6. Sum capped per-wallet contributions across the cohort.
///
/// Returns the raw decayed-WETH sum; caller applies `VELOCITY_REFERENCE`
/// normalization (§6.7).
function computeVelocityRaw(t: TokenStats, now: bigint): number {
  const halfLife = VELOCITY_DECAY_HALFLIFE_SEC;
  const lookback = BigInt(VELOCITY_LOOKBACK_SEC);
  const churnWindow = BigInt(VELOCITY_CHURN_WINDOW_SEC);

  // All in-window buy timestamps per wallet, sorted ascending. We can't store
  // only the latest: an attacker who buys, dumps within the churn window,
  // then places a tiny later buy would shift "latest" past the dump and
  // bypass the discount. Instead each sell looks up the latest buy that
  // happened *before or at* the sell time — a later buy can't reset the check.
  const buyTimestampsByWallet = new Map<Address, bigint[]>();
  for (const b of t.buys) {
    if (b.ts > now) continue;
    if (now - b.ts > lookback) continue;
    const arr = buyTimestampsByWallet.get(b.wallet);
    if (arr) arr.push(b.ts);
    else buyTimestampsByWallet.set(b.wallet, [b.ts]);
  }
  for (const arr of buyTimestampsByWallet.values()) {
    arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const buyDecayedByWallet = new Map<Address, number>();
  for (const buy of t.buys) {
    if (buy.ts > now) continue;
    const age = Number(now - buy.ts);
    if (age > VELOCITY_LOOKBACK_SEC) continue;
    const decay = Math.pow(0.5, age / halfLife);
    const amt = bigintToFloat(buy.amountWeth) * decay;
    buyDecayedByWallet.set(buy.wallet, (buyDecayedByWallet.get(buy.wallet) ?? 0) + amt);
  }

  const sellDecayedByWallet = new Map<Address, number>();
  for (const sell of t.sells) {
    if (sell.ts > now) continue;
    const age = Number(now - sell.ts);
    if (age > VELOCITY_LOOKBACK_SEC) continue;
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
    const churnBoost = churn ? VELOCITY_CHURN_PENALTY_FACTOR : 1;

    const amt = bigintToFloat(sell.amountWeth) * decay * churnBoost;
    sellDecayedByWallet.set(sell.wallet, (sellDecayedByWallet.get(sell.wallet) ?? 0) + amt);
  }

  let total = 0;
  // WETH unit conversion: amounts are wei (1e18); per-wallet cap is in WETH
  // (≈1e18 wei). Apply cap in WETH-units after dividing.
  const capWei = VELOCITY_PER_WALLET_CAP_WETH * 1e18;
  for (const [wallet, buyDec] of buyDecayedByWallet) {
    const sellDec = sellDecayedByWallet.get(wallet) ?? 0;
    const net = Math.max(0, buyDec - sellDec);
    if (net <= 0) continue;
    const capped = Math.min(net, capWei);
    total += capped / 1e18;
  }
  return total;
}

/// Effective buyers raw value — sqrt-dampened headcount of meaningful buyers
/// in the lookback window. Spec §6.4.2 (locked 2026-05-04).
///
/// Per the locked formula:
///   1. For each wallet, sum its buy volume within `EFFECTIVE_BUYERS_LOOKBACK_SEC`.
///   2. Drop wallets whose in-window buy volume < `EFFECTIVE_BUYERS_DUST_WETH`.
///   3. Score = Σ sqrt(in_window_volume_weth) across surviving wallets.
///
/// Returns the raw sqrt-sum; caller applies `EFFECTIVE_BUYERS_REFERENCE`
/// normalization (§6.7).
function computeEffectiveBuyersRaw(t: TokenStats, now: bigint): number {
  const lookback = BigInt(EFFECTIVE_BUYERS_LOOKBACK_SEC);
  const dust = EFFECTIVE_BUYERS_DUST_WETH;

  // Build per-wallet in-window buy volume from `buys`. Falls back to
  // `volumeByWallet` (full-life cumulative) when `buys` is empty — the
  // pre-1.22 inputs (Epic 1.17b indexer) shipped only the cumulative map,
  // so this preserves backwards compat for callers that haven't migrated.
  const windowedByWallet = new Map<Address, number>();
  if (t.buys.length > 0) {
    for (const buy of t.buys) {
      if (buy.ts > now) continue;
      if (now - buy.ts > lookback) continue;
      const v = bigintToFloat(buy.amountWeth) / 1e18;
      windowedByWallet.set(buy.wallet, (windowedByWallet.get(buy.wallet) ?? 0) + v);
    }
  } else {
    for (const [wallet, vol] of t.volumeByWallet) {
      windowedByWallet.set(wallet, bigintToFloat(vol) / 1e18);
    }
  }

  let sum = 0;
  for (const v of windowedByWallet.values()) {
    if (v < dust) continue;
    sum += Math.sqrt(v);
  }
  return sum;
}

/// Sticky liquidity raw value — TVL term minus amount-decayed withdrawal
/// penalty over the 24h LP-event window. Spec §6.4.3 (locked 2026-05-04).
///
/// Per the locked formula:
///   - `TVL_TERM = avgLiquidityDepthWeth` (or `liquidityDepthWeth` fallback).
///   - For each LP `remove` event with age `Δt < LP_PENALTY_WINDOW_SEC`:
///       penalty += amount × exp(-Δt / LP_PENALTY_TAU_SEC)
///   - Score = max(0, TVL_TERM − penalty) × ageFactor
///   - ageFactor = min(1, token_age_hours / max(1, token_age_hours))
///     where the slot-fairness denominator `max(1, token_age_hours)` (§6.9)
///     means a 24h-old maximally-sticky LP can score 1.0 within its window.
///
/// Backwards-compat fallback: when `lpEvents` is omitted, falls back to the
/// pre-1.22 aggregate path (`recentLiquidityRemovedWeth × α`). The pre-lock
/// `α` was 1.0; preserved here.
function computeStickyLiquidityRaw(
  t: TokenStats,
  now: bigint,
  config: ScoringConfig,
): number {
  const avg = t.avgLiquidityDepthWeth ?? t.liquidityDepthWeth;
  const avgF = bigintToFloat(avg) / 1e18;
  if (avgF <= 0) return 0;

  let penalty = 0;
  if (t.lpEvents && t.lpEvents.length > 0) {
    // Locked path: per-event penalty with `exp(-Δt / 6h)` decay.
    for (const ev of t.lpEvents) {
      if (ev.ts > now) continue;
      if (ev.amountWethSigned >= 0n) continue; // adds don't penalize
      const age = Number(now - ev.ts);
      if (age > LP_PENALTY_WINDOW_SEC) continue;
      const removed = bigintToFloat(-ev.amountWethSigned) / 1e18;
      const decay = Math.exp(-age / LP_PENALTY_TAU_SEC);
      penalty += removed * decay;
    }
  } else {
    // Backwards-compat path: pre-1.22 aggregate input shape.
    const removedF = bigintToFloat(t.recentLiquidityRemovedWeth ?? 0n) / 1e18;
    penalty = removedF * config.recentWithdrawalPenalty;
  }

  // Slot-fairness ageFactor (§6.9) — only relevant when token_age_hours < 24
  // (i.e., during the launch's first day). For older tokens the penalty
  // window is fully populated and ageFactor saturates at 1.0.
  const ageFactor = stickyLiquidityAgeFactor(t, now);

  return Math.max(0, avgF - penalty) * ageFactor;
}

/// Slot-fairness ageFactor for sticky liquidity (§6.9). The spec amendment
/// replaces the pre-lock fixed-window denominator (96h) with `max(1,
/// token_age_hours)`, capped at the active LP-penalty window. Net effect:
///   - tokens ≥ 1h old → ageFactor saturates at 1.0 (no penalty for being
///     "young" once you've cleared the floor)
///   - tokens < 1h old → ageFactor = token_age_hours (proportional ramp)
///   - launchedAt missing → 1.0 (legacy callers)
///
/// The "12h-old launch with 12h of maximally-sticky LP scores 1.0" example
/// from the spec amendment falls out of this: ageHours = 12, observedHours =
/// min(12, 24) = 12, denom = max(1, min(12, 24)) = 12, ageFactor = 12/12 = 1.
function stickyLiquidityAgeFactor(t: TokenStats, now: bigint): number {
  if (t.launchedAt === undefined) return 1;
  if (now <= t.launchedAt) return 0;
  const ageSec = Number(now - t.launchedAt);
  const ageHours = ageSec / 3600;
  const windowHours = LP_PENALTY_WINDOW_SEC / 3600;
  const observedHours = Math.min(ageHours, windowHours);
  const denom = Math.max(1, Math.min(ageHours, windowHours));
  return Math.min(1, observedHours / denom);
}

/// Two-anchor retention with §6.4.4 ageFactor + §6.4.4 dust threshold.
///
/// Per the locked formula:
///   - retentionRatio = |currentHolders ∩ anchor| / |anchor|, applied per
///     anchor (long + optional short), weighted blend with config defaults.
///   - Holders below `RETENTION_DUST_SUPPLY_FRAC × totalSupply` excluded
///     from both sets before the ratio is computed (when balance + supply
///     data is available; otherwise dust filter is skipped).
///   - retention = retentionRatio × ageFactor where
///     ageFactor = min(1, token_age_hours / max(1, token_age_hours))
///     — same slot-fairness denominator as sticky liquidity (§6.9).
///
/// Already in [0, 1] by construction — not subject to fixed-reference
/// normalization.
function computeRetention(t: TokenStats, now: bigint, config: ScoringConfig): number {
  const longAnchor = applyRetentionDust(t.holdersAtRetentionAnchor, t);
  const longFrac = retentionFraction(longAnchor, applyRetentionDustToCurrent(t.currentHolders, t));

  let baseFrac: number;
  if (!t.holdersAtRecentAnchor) {
    baseFrac = longFrac;
  } else {
    const shortAnchor = applyRetentionDust(t.holdersAtRecentAnchor, t);
    const shortFrac = retentionFraction(
      shortAnchor,
      applyRetentionDustToCurrent(t.currentHolders, t),
    );
    const lw = config.retentionLongWeight;
    const sw = config.retentionShortWeight;
    const total = lw + sw;
    baseFrac = total > 0 ? (lw * longFrac + sw * shortFrac) / total : 0;
  }

  return baseFrac * retentionAgeFactor(t, now);
}

/// Retention slot-fairness ageFactor (§6.9). Same shape as
/// `stickyLiquidityAgeFactor`: saturates at 1.0 for tokens ≥ 1h old, scales
/// proportionally below that. The "anchor window" for retention is the
/// long-anchor convention (24h).
///   - 24h-old token: anchor=24, denom=24, ageFactor = 1.0
///   - 1h-old token: anchor=1, denom=1, ageFactor = 1.0
///   - 0.5h-old token: anchor=0.5, denom=1, ageFactor = 0.5
function retentionAgeFactor(t: TokenStats, now: bigint): number {
  if (t.launchedAt === undefined) return 1;
  if (now <= t.launchedAt) return 0;
  const ageSec = Number(now - t.launchedAt);
  const ageHours = ageSec / 3600;
  const anchorWindowHours = 24;
  const observedHours = Math.min(ageHours, anchorWindowHours);
  const denom = Math.max(1, Math.min(ageHours, anchorWindowHours));
  return Math.min(1, observedHours / denom);
}

/// Apply retention dust filter to an anchor holder set. Returns the input
/// unchanged when balance/supply data is absent (legacy callers).
function applyRetentionDust(
  anchor: ReadonlySet<Address> | undefined,
  t: TokenStats,
): ReadonlySet<Address> {
  if (!anchor) return new Set();
  if (!t.holderBalancesAtRetentionAnchor || t.totalSupply === undefined) return anchor;
  const supplyF = bigintToFloat(t.totalSupply);
  if (supplyF <= 0) return anchor;
  const dustWei = supplyF * RETENTION_DUST_SUPPLY_FRAC;
  const out = new Set<Address>();
  for (const h of anchor) {
    const balF = bigintToFloat(t.holderBalancesAtRetentionAnchor.get(h) ?? 0n);
    if (balF >= dustWei) out.add(h);
  }
  return out;
}

/// Apply retention dust filter to the current-holder set. Mirrors
/// `applyRetentionDust` but reads from `holderBalances` (per spec §41.3 the
/// HHI/concentration component already consumes this). Returns input
/// unchanged when balance/supply data is absent.
function applyRetentionDustToCurrent(
  current: ReadonlySet<Address>,
  t: TokenStats,
): ReadonlySet<Address> {
  if (!t.holderBalancesAtRetentionAnchor || t.totalSupply === undefined) return current;
  const supplyF = bigintToFloat(t.totalSupply);
  if (supplyF <= 0) return current;
  const dustWei = supplyF * RETENTION_DUST_SUPPLY_FRAC;
  const out = new Set<Address>();
  for (const h of current) {
    // Anchor balances are the most-recent we have; current-balance map isn't
    // separately exposed in TokenStats yet (Epic 1.22b will add). Use the
    // anchor balance as the conservative proxy — the failure mode (a holder
    // who's grown above dust between anchor and now is excluded) is mild.
    const balF = bigintToFloat(t.holderBalancesAtRetentionAnchor.get(h) ?? 0n);
    if (balF >= dustWei) out.add(h);
  }
  return out;
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

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function bigintToFloat(b: bigint): number {
  return Number(b);
}

// Re-export for convenience (tests + boundary code spy on these).
export {LOCKED_WEIGHTS, HP_WEIGHTS_VERSION};
