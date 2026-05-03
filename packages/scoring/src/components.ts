/// Component-level helpers extracted from `score.ts`.
///
/// The momentum + holderConcentration computations live here (not inline in
/// `score.ts`) so production callers and tests can spy on them via the
/// module namespace. `score` consumes them through a `* as components`
/// import so vi.spyOn(components, "computeMomentumComponent") replaces the
/// reference the scorer actually invokes — the gate test in
/// `test/v4_lock_smoke.test.ts` relies on this seam to assert the flag-off
/// path skips the compute entirely.

import type {ScoringConfig, TokenStats} from "./types.js";

/// Holder concentration — Herfindahl-Hirschman Index (HHI) mapped to [0, 1].
/// Mirrors the Track E v4 formula in `track-e/pipeline.py:hhi_score` so a
/// row scored on-chain matches its retrospective Track E recompute exactly.
///
///   HHI = 10000 × Σ(p_i²) where p_i = balance_i / Σ(balances)
///   score = 1 - log10(max(HHI, 1)) / log10(10000)
///
/// Reference points (spec §41.5):
///   HHI 10000 (one holder) → 0.0
///   HHI 1000               → 0.25
///   HHI 100                → 0.50
///   HHI 10                 → 0.75
///   HHI 1                  → 1.0
///
/// Inputs are post-§41.3 filtering (protocol/burn/pool addresses excluded
/// upstream of scoring). When `holderBalances` is omitted or empty, the
/// component scores 0 — a token with no holder-distribution data can't
/// claim distribution credit.
export function computeHolderConcentration(t: TokenStats): number {
  const balances = t.holderBalances;
  if (!balances || balances.length === 0) return 0;
  let totalF = 0;
  for (const b of balances) totalF += Number(b);
  if (totalF <= 0) return 0;
  let sumSquares = 0;
  for (const b of balances) {
    const share = Number(b) / totalF;
    sumSquares += share * share;
  }
  const hhi = 10000 * sumSquares;
  const raw = 1 - Math.log10(Math.max(hhi, 1)) / Math.log10(10000);
  if (Number.isNaN(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

/// Momentum component compute. Extracted to this module (not score.ts) so
/// the gate test can spy on it via `vi.spyOn(components, ...)` and assert
/// the `flags.momentum === false` path does NOT invoke this function.
///
/// - No prior history → neutral 0.5 (a fresh token is neither hot nor cold).
/// - The neutral baseline is deliberately NOT subject to `momentumCap`: an
///   operator tightening the cap below 0.5 must not retroactively penalize
///   tokens with no momentum signal yet.
/// - With a prior, the post-normalization momentum is clipped to
///   `momentumCap` so operators can bound momentum's contribution.
export function computeMomentumComponent(
  priorBaseComposite: number | undefined,
  baseComposite: number,
  config: ScoringConfig,
): number {
  if (typeof priorBaseComposite !== "number") return 0.5;
  const delta = baseComposite - priorBaseComposite;
  const clipped = Math.max(-1, Math.min(1, delta / config.momentumScale));
  return Math.min((clipped + 1) / 2, config.momentumCap);
}
