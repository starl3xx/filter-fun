/// HP component formula constants (locked 2026-05-04 — spec §6.4.x + §6.7).
///
/// Every parameter the four shaped components depend on lives here, named,
/// typed, and exported. Formula bodies in `score.ts` MUST reference these by
/// name — zero magic numbers in the formula path. A change to any constant
/// is a behavioral change to HP and follows the same ≥7-day public-notice
/// procedure as a weight change (see `docs/scoring-weights.md` §5).
///
/// **Why a separate module.** The constants are the audit surface for "engine
/// matches spec." External auditors `cat` this file and cross-check against
/// the spec amendment. If the value drifts, the diff is the audit trail.
///
/// **Provenance.** `*_REFERENCE` values were calibrated from the Track E v5
/// validation cohort (n=43, top-50/platform pass — see
/// `track-e/REPORT_v5_formula_lock.md`) at the 90th percentile per spec §6.7
/// fixed-reference normalization. Re-calibrating these requires a refit run
/// + a Spearman ρ check against the locked +0.36 ± 0.10 band.

/// Hard time-window for velocity contributions (seconds). A buy older than
/// this is dropped from the sum entirely, regardless of decay weight. Spec
/// §6.4.1.
export const VELOCITY_LOOKBACK_SEC = 96 * 3600;

/// Half-life (seconds) for the time-decay weight applied to in-window buys
/// and sells. `weight = 0.5 ^ (age / VELOCITY_DECAY_HALFLIFE_SEC)`.
///
/// **Decay-model decision (Epic 1.22).** The spec amendment names
/// `VELOCITY_DECAY_TAU = 24h`; the engine uses a half-life model rather than
/// exponential τ. Half-life of 24h ≡ exponential τ ≈ 34.66h
/// (`24 / ln(2)`). Half-life is preserved here because (a) it's what the
/// engine has shipped under and what Track E v5 validated, and (b) the
/// difference is a constant rescale that the calibrated `VELOCITY_REFERENCE`
/// absorbs. Spec text reads "τ = 24h half-life" — interpret τ as the
/// half-life parameter, not the exponential time constant.
export const VELOCITY_DECAY_HALFLIFE_SEC = 24 * 3600;

/// Absolute per-wallet cap (WETH) on the per-wallet velocity contribution.
/// A wallet with `net > VELOCITY_PER_WALLET_CAP_WETH` decayed-WETH net inflow
/// contributes exactly `VELOCITY_PER_WALLET_CAP_WETH` — no whale dominance.
/// Spec §6.4.1 + §6.4.7 (anti-whale + sybil dampening).
export const VELOCITY_PER_WALLET_CAP_WETH = 10;

/// Window (seconds) within which a same-wallet sell after a buy is considered
/// churn (pump-and-dump signal). The sell's decayed weight is multiplied by
/// `VELOCITY_CHURN_PENALTY_FACTOR` to penalize wallets that buy and dump
/// inside this window.
export const VELOCITY_CHURN_WINDOW_SEC = 60 * 60;

/// Multiplier on the decayed weight of a churn-detected sell. Default 2.0:
/// a buy → sell within `VELOCITY_CHURN_WINDOW_SEC` zeros the wallet's net
/// contribution faster than a non-churn sell would. Engine convention preserved
/// from pre-lock; not in the spec text but documented here as the locked value
/// per Epic 1.22 (operator can amend in a future weight-change cycle if Track E
/// shows the factor is wrong).
export const VELOCITY_CHURN_PENALTY_FACTOR = 2;

/// Effective-buyers lookback window (seconds). A wallet is counted only if
/// its in-window buy volume sums above the dust threshold. Mirrors
/// `VELOCITY_LOOKBACK_SEC` so the two components score the same trade horizon.
/// Spec §6.4.2.
export const EFFECTIVE_BUYERS_LOOKBACK_SEC = 96 * 3600;

/// Per-wallet dust threshold (WETH) for the effective-buyers count. Wallets
/// with in-window buy volume below this contribute exactly zero — sybil
/// resistance against 1-wei address swarms. Spec §6.4.2 (locked at 0.001
/// WETH, 2026-05-04).
///
/// **Audit note.** Pre-lock (`HP_WEIGHTS_VERSION = "2026-05-05-v4-locked-int10k"`)
/// the threshold was 0.005 WETH (5e15 wei). The lock tightens it to 0.001 WETH
/// to match the spec's named threshold and align with the per-wallet log-cap
/// floor (`VELOCITY_PER_WALLET_CAP_FLOOR_WETH`).
export const EFFECTIVE_BUYERS_DUST_WETH = 0.001;

/// LP-event decay window (seconds) over which a withdrawal contributes to the
/// sticky-liquidity penalty. Withdrawals older than this are dropped. Spec
/// §6.4.3.
export const LP_PENALTY_WINDOW_SEC = 24 * 3600;

/// Decay constant (seconds) for the withdrawal penalty: a withdrawal at age
/// `Δt` contributes `amount × exp(-Δt / LP_PENALTY_TAU_SEC)` to the penalty
/// sum. Spec §6.4.3.
export const LP_PENALTY_TAU_SEC = 6 * 3600;

/// Retention dust threshold expressed as a fraction of token total supply.
/// Holders with balance below `RETENTION_DUST_SUPPLY_FRAC × totalSupply` are
/// excluded from both the anchor set and the current set. Spec §6.4.4
/// (acknowledged airdrop-padding gap addressed in v2; v1 ships with this
/// floor + structural defenses).
export const RETENTION_DUST_SUPPLY_FRAC = 0.0001;

/// Per-component fixed-reference values (spec §6.7). A token's normalized
/// component score is `min(1, raw / REFERENCE)` — same input → same score
/// regardless of cohort composition. Calibrated from the Track E v5
/// liquidity-first cohort (n=43, top-50/platform pass) at the 90th percentile.
///
/// **Provenance:** `track-e/REPORT_v5_formula_lock.md` §3 records the per-row
/// raw values + the 90th-percentile derivation. Re-calibration requires a
/// Track E refit + Spearman ρ verification within the +0.36 ± 0.10 band.
///
/// Retention + holderConcentration components are already in [0, 1] by
/// construction (intersection ratio + HHI mapping respectively) — no
/// reference normalization is applied to them.
export const VELOCITY_REFERENCE = 1115.451;
export const EFFECTIVE_BUYERS_REFERENCE = 191.129;
export const STICKY_LIQUIDITY_REFERENCE = 67.275;

/// Bundle for the `/scoring/weights` endpoint. Surfaces every named constant
/// alongside the locked weights so external auditors can read the full
/// active configuration in one HTTP fetch.
export const FORMULA_CONSTANTS = {
  VELOCITY_LOOKBACK_SEC,
  VELOCITY_DECAY_HALFLIFE_SEC,
  VELOCITY_PER_WALLET_CAP_WETH,
  VELOCITY_CHURN_WINDOW_SEC,
  VELOCITY_CHURN_PENALTY_FACTOR,
  EFFECTIVE_BUYERS_LOOKBACK_SEC,
  EFFECTIVE_BUYERS_DUST_WETH,
  LP_PENALTY_WINDOW_SEC,
  LP_PENALTY_TAU_SEC,
  RETENTION_DUST_SUPPLY_FRAC,
  VELOCITY_REFERENCE,
  EFFECTIVE_BUYERS_REFERENCE,
  STICKY_LIQUIDITY_REFERENCE,
} as const;

export type FormulaConstants = typeof FORMULA_CONSTANTS;
