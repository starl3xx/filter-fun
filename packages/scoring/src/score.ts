import {
  DEFAULT_CONFIG,
  type ScoredToken,
  type ScoringConfig,
  type TokenStats,
} from "./types.js";

/// Computes a normalized composite score for each token in the cohort and returns them in
/// descending score order with rank attached. Pure function — caller supplies `currentTime`
/// (no `Date.now()` dependency keeps it deterministic for tests + reproducible for oracle use).
export function score(
  tokens: ReadonlyArray<TokenStats>,
  currentTime: bigint,
  config: ScoringConfig = DEFAULT_CONFIG,
): ScoredToken[] {
  if (tokens.length === 0) return [];

  const raw = tokens.map((t) => ({
    token: t.token,
    volumeVelocity: computeVolumeVelocity(t, currentTime, config),
    uniqueBuyers: computeUniqueBuyers(t),
    liquidityDepth: bigintToFloat(t.liquidityDepthUsdc),
    retention: computeRetention(t),
  }));

  const normVel = normalizeMinMax(raw.map((r) => r.volumeVelocity));
  const normBuy = normalizeMinMax(raw.map((r) => r.uniqueBuyers));
  const normLiq = normalizeMinMax(raw.map((r) => r.liquidityDepth));
  const normRet = normalizeMinMax(raw.map((r) => r.retention));

  const w = config.weights;
  const scored = raw.map((r, i) => {
    const components = {
      volumeVelocity: normVel[i] ?? 0,
      uniqueBuyers: normBuy[i] ?? 0,
      liquidityDepth: normLiq[i] ?? 0,
      retention: normRet[i] ?? 0,
    };
    const composite =
      w.volumeVelocity * components.volumeVelocity +
      w.uniqueBuyers * components.uniqueBuyers +
      w.liquidityDepth * components.liquidityDepth +
      w.retention * components.retention;
    return {token: r.token, score: composite, components};
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s, idx) => ({...s, rank: idx + 1}));
}

/// Time-decayed volume with per-wallet log-cap (sybil resistance).
function computeVolumeVelocity(
  t: TokenStats,
  currentTime: bigint,
  config: ScoringConfig,
): number {
  let total = 0;
  const halfLife = config.velocityHalfLifeSec;
  const floor = bigintToFloat(config.walletCapFloorUsdc);

  for (const buy of t.buys) {
    const ageSec = Number(currentTime - buy.ts);
    if (ageSec < 0) continue;
    const decay = Math.pow(0.5, ageSec / halfLife);

    const walletTotal = bigintToFloat(t.volumeByWallet.get(buy.wallet) ?? 0n);
    const amount = bigintToFloat(buy.amountUsdc);

    // Diminishing returns at the wallet level: a wallet with very large cumulative volume
    // contributes log-scaled weight rather than linear, dampening single-whale effects.
    const cap = walletTotal > floor ? Math.log2(1 + walletTotal / floor) : 1;
    total += (amount / Math.max(cap, 1)) * decay;
  }
  return total;
}

/// Sqrt diminishing returns on raw unique-buyer count.
function computeUniqueBuyers(t: TokenStats): number {
  return Math.sqrt(t.volumeByWallet.size);
}

/// Fraction of anchor-time holders still holding now.
function computeRetention(t: TokenStats): number {
  if (t.holdersAtRetentionAnchor.size === 0) return 0;
  let still = 0;
  for (const h of t.holdersAtRetentionAnchor) {
    if (t.currentHolders.has(h)) still++;
  }
  return still / t.holdersAtRetentionAnchor.size;
}

/// Min-max scale to [0, 1]. Uniform values map to 0 (no signal).
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

function bigintToFloat(b: bigint): number {
  // Lossy at very large magnitudes but fine for USDC / token-volume scoring scales.
  return Number(b);
}
