export type Address = `0x${string}`;

/// Per-token aggregated metrics produced by the indexer (or test fixtures).
/// All `bigint` amounts are in WETH raw units (1e18) unless noted.
export interface TokenStats {
  /// Token contract address.
  token: Address;

  // ── Trades ──────────────────────────────────────────────
  /// Cumulative buy volume per wallet, in WETH raw units.
  volumeByWallet: Map<Address, bigint>;
  /// Each individual buy, time-stamped — used for time-decayed velocity.
  buys: ReadonlyArray<{wallet: Address; ts: bigint; amountWeth: bigint}>;
  /// Each individual sell, time-stamped. Velocity uses decayed net inflow,
  /// not gross volume; sells reduce the wallet's contribution and a sell that
  /// lands within `churnWindowSec` of a same-wallet buy is doubly discounted.
  sells: ReadonlyArray<{wallet: Address; ts: bigint; amountWeth: bigint}>;

  // ── Liquidity ───────────────────────────────────────────
  /// Current LP base-asset depth (WETH).
  liquidityDepthWeth: bigint;
  /// Time-weighted average depth over the trailing sticky-liquidity window
  /// (indexer-aggregated). Defaults to `liquidityDepthWeth` if unset — fine for
  /// genesis, but the indexer should populate it as soon as it tracks history.
  avgLiquidityDepthWeth?: bigint;
  /// Total LP withdrawn within the recent withdrawal window (e.g. last hour).
  /// Drives the sticky-liquidity penalty: a token whose LP just dumped scores
  /// lower even if its current/avg depth still looks reasonable.
  recentLiquidityRemovedWeth?: bigint;

  // ── Holders ─────────────────────────────────────────────
  /// Wallets currently holding any positive balance.
  currentHolders: ReadonlySet<Address>;
  /// Holders at the long anchor (e.g. 24h ago). Conviction signal.
  holdersAtRetentionAnchor: ReadonlySet<Address>;
  /// Holders at a short anchor (e.g. 1h ago). Catches tokens that are bleeding
  /// recent buyers even while older holders look stable. Optional — if unset,
  /// retention falls back to the long anchor only.
  holdersAtRecentAnchor?: ReadonlySet<Address>;
  /// Per-wallet token balances after spec §41.3 filtering (protocol/burn/pool
  /// addresses excluded upstream of scoring). Drives the holderConcentration
  /// component via HHI. Optional — when omitted, the concentration component
  /// scores 0 (a token with no holder data can't claim distribution credit).
  /// Order is irrelevant; only the magnitude distribution matters.
  holderBalances?: ReadonlyArray<bigint>;
  /// Per-anchor-holder balance (token wei). Used by retention to apply the
  /// `RETENTION_DUST_SUPPLY_FRAC` floor. When omitted, the dust filter is
  /// skipped (legacy behavior — every anchor holder counts regardless of
  /// balance). Indexer projection (Epic 1.22b / PR 2) populates this.
  holderBalancesAtRetentionAnchor?: ReadonlyMap<Address, bigint>;
  /// Per-anchor-holder first-seen timestamp (unix-seconds). Used by retention
  /// to compute the per-holder ageFactor. When omitted, ageFactor falls back
  /// to a flat 1.0 (no fairness adjustment) and retention reduces to the
  /// pre-lock retentionRatio. Indexer projection (Epic 1.22b / PR 2) populates
  /// this.
  holderFirstSeenAt?: ReadonlyMap<Address, bigint>;
  /// Total token supply (wei) — denominator for `RETENTION_DUST_SUPPLY_FRAC`.
  /// When omitted, dust filter falls back to the largest anchor balance × frac
  /// (defensive — avoids divide-by-zero, but less precise than true supply).
  totalSupply?: bigint;
  /// Per-event LP timeline. Each entry is one V4 ModifyLiquidity event,
  /// expressed as a signed delta on the WETH leg: `+amount` for an add,
  /// `-amount` for a remove. Drives the locked sticky-liquidity penalty
  /// (`exp(-Δt / LP_PENALTY_TAU_SEC)` decay over `LP_PENALTY_WINDOW_SEC`)
  /// + amount-weighted age. When omitted, sticky-liquidity falls back to the
  /// pre-lock aggregate path (`liquidityDepthWeth` / `avgLiquidityDepthWeth`
  /// — `recentLiquidityRemovedWeth`). Indexer projection (Epic 1.22b / PR 2)
  /// populates this.
  lpEvents?: ReadonlyArray<{ts: bigint; amountWethSigned: bigint}>;

  // ── Momentum ────────────────────────────────────────────
  /// Last tick's pre-momentum composite (0..1). Producer-managed state — the
  /// indexer/oracle stores the previous result and feeds it back here. If
  /// unset, momentum is neutral (0.5). The momentum component is bounded so
  /// it can't dominate the final HP regardless of how large the delta is.
  ///
  /// Under the v4-locked weights (`HP_WEIGHTS_VERSION`) momentum's coefficient
  /// is 0 and the `HP_MOMENTUM_ENABLED` flag defaults to `false`, so this
  /// field is ignored end-to-end. Producers should keep storing it anyway —
  /// flipping the flag for a future v5 weight set must not require an
  /// indexer-state migration.
  priorBaseComposite?: number;

  // ── Tie-break (Epic 1.18) ──────────────────────────────
  /// Unix-seconds the token launched. Used as the secondary sort key when two
  /// tokens land on the exact-same integer HP — earlier `launchedAt` wins
  /// (spec §6.5 "Composite scale + tie-break"). Optional: when omitted, the
  /// tie falls through to the stable Array.sort order. Off-chain only; the
  /// oracle Merkle root encodes the resolved rank.
  launchedAt?: bigint;
}

/// Filter-week phases. Retained for API compatibility — under
/// `HP_WEIGHTS_VERSION = "2026-05-03-v4-locked"` both phases resolve to the
/// same single weight set (per spec §6.5 collapse). A future v5 may revive
/// per-phase differentiation without forcing a public-API refactor.
export type Phase = "preFilter" | "finals";

export interface ScoringWeights {
  velocity: number;
  effectiveBuyers: number;
  stickyLiquidity: number;
  retention: number;
  momentum: number;
  /// Per spec §41 / Track E v4 lock. HHI-based: lower concentration → higher
  /// score. Already in [0, 1]; not min-max normalized.
  holderConcentration: number;
}

/// Single source of truth for the active component coefficients. Locked
/// 2026-05-03 per Track E v4 (`track-e/REPORT.md` Scenario B + drop momentum)
/// and spec §6.5. Sums to 1.0 exactly.
///
///   velocity            0.30
///   effectiveBuyers     0.15
///   stickyLiquidity     0.30
///   retention           0.15
///   momentum            0.00  ← coefficient zeroed; component still wired
///                                via HP_MOMENTUM_ENABLED for future revival
///   holderConcentration 0.10
///
/// Off-chain config: contracts NEVER read these values — they consume the
/// oracle-published Merkle root of rankings (spec §42.2.6 oracle authority).
/// Updates to this set require ≥7-day public notice per the documented
/// weight-update procedure.
export const LOCKED_WEIGHTS: ScoringWeights = {
  velocity: 0.30,
  effectiveBuyers: 0.15,
  stickyLiquidity: 0.30,
  retention: 0.15,
  momentum: 0.00,
  holderConcentration: 0.10,
} as const;

/// Active version stamped on every HP snapshot the indexer writes. Bump only
/// in lockstep with `LOCKED_WEIGHTS` *or* the composite scale (§6.5) *or*
/// any of the formula constants in `constants.ts` (Epic 1.22 — §6.4.x +
/// §6.7–§6.13 lock).
///
/// **Epic 1.22 (2026-05-04).** Bumped from `2026-05-05-v4-locked-int10k` to
/// `-formulas` to mark the per-component formula lock: hard 96h lookbacks,
/// fixed-reference normalization (§6.7), absolute per-wallet velocity cap
/// (§6.4.1), retention ageFactor + dust threshold (§6.4.4), sticky-liquidity
/// per-event LP timeline with `exp(-Δt / 6h)` decay (§6.4.3), slot-fairness
/// `max(1, token_age_hours)` denominator (§6.9), and three-tier tie-break
/// (§6.10). Underlying weight values are unchanged — same Track E v4 lock —
/// only the formula bodies + named constants moved.
///
/// Pre-1.22 (`-int10k`) used min-max cohort normalization + magic numbers in
/// formula bodies; the locked version replaces both. The version-string date
/// (2026-05-04) is the spec-amendment date; activation date may differ and
/// is recorded separately in `HP_WEIGHTS_ACTIVATED_AT`.
export const HP_WEIGHTS_VERSION = "2026-05-04-v4-locked-int10k-formulas" as const;

/// Wall-clock timestamp at which `HP_WEIGHTS_VERSION` activated. Surfaced via
/// the public `/scoring/weights` endpoint so external auditors can verify
/// "what was live when" without reading commit history. Activation is gated
/// on the §6.5 ≥7-day public-notice procedure documented in
/// `docs/scoring-weights.md` §5.
export const HP_WEIGHTS_ACTIVATED_AT = "2026-05-11T00:00:00Z" as const;

/// Composite-HP scale constants (Epic 1.18 / spec §6.5).
///
/// HP is stored and exchanged as a non-negative integer in `[HP_MIN, HP_MAX]`
/// — same effective resolution as the prior float [0, 1] with two decimal
/// places, but with cleaner storage (integer column), alignment to the BPS
/// convention used elsewhere in the protocol (§9.2, §9.4, §11.1, §41.4 HHI),
/// and elimination of float-precision bugs at rank-cut boundaries.
///
/// Rounding mode: round-half-up (`Math.round` for positives), applied once
/// to the final weighted sum. Track E's Python pipeline uses
/// `int(weighted_sum * 10000 + 0.5)` for byte-equivalent behavior — banker's
/// rounding (Python's default `round`) would diverge at exact half-points.
export const HP_MIN = 0 as const;
export const HP_MAX = 10000 as const;
export const HP_COMPOSITE_SCALE = {
  min: HP_MIN,
  max: HP_MAX,
  type: "integer",
} as const;

/// Spec anchor for the active weights + locked formulas. Surfaced on
/// `/scoring/weights` and referenced from operator runbooks. Updated for
/// Epic 1.22: anchors §6.4.x (formula lock) + §6.5 (weight lock) + §6.7
/// (fixed-reference normalization) + §6.13 (test fixture coverage).
export const HP_WEIGHTS_SPEC_REF =
  "https://github.com/starl3xx/filter-fun/blob/main/filter_fun_comprehensive_spec.md#64-hp-component-formulas-locked-2026-05-04" as const;

/// Backwards-compat aliases. Under v4 every phase resolves to `LOCKED_WEIGHTS`.
/// `weightsForPhase` (below) consolidates the lookup so callers don't depend
/// on which constant they got back.
export const DEFAULT_WEIGHTS: ScoringWeights = LOCKED_WEIGHTS;
export const PRE_FILTER_WEIGHTS: ScoringWeights = LOCKED_WEIGHTS;
export const FINALS_WEIGHTS: ScoringWeights = LOCKED_WEIGHTS;

/// UI-facing labels. Keep these short, plain-English, and free of math —
/// the leaderboard tooltips render these directly.
export const COMPONENT_LABELS = {
  velocity: "Buying activity",
  effectiveBuyers: "Real participants",
  stickyLiquidity: "Liquidity strength",
  retention: "Holder conviction",
  momentum: "Momentum",
  holderConcentration: "Holder distribution",
} as const;

export interface ComponentBreakdown {
  /// Normalized [0, 1] component score across the cohort.
  score: number;
  /// Weight applied to this component when computing the final HP. Reflects
  /// any flag-driven renormalization (see `WeightFlags`).
  weight: number;
  /// Plain-English label for UI.
  label: string;
}

/// Mirror of the env-readable feature flags. Stamped onto every `ScoredToken`
/// so downstream snapshots record the gating state at compute time.
export interface WeightFlags {
  /// `HP_MOMENTUM_ENABLED`. Default `false` per spec §6.4.5: momentum is
  /// disabled in v4. When `false`, the momentum component returns 0
  /// unconditionally and the cost of computing it is not paid.
  momentum: boolean;
  /// `HP_CONCENTRATION_ENABLED`. Default `true` per spec §41. When `false`,
  /// holderConcentration returns 0 and the remaining components renormalize
  /// to sum to 1.0 so the HP invariant (HP ∈ [0, 1]) is preserved.
  concentration: boolean;
}

export const DEFAULT_FLAGS: WeightFlags = {
  momentum: false,
  concentration: true,
} as const;

export interface ScoredToken {
  token: Address;
  rank: number;
  /// Final weighted HP — integer in `[HP_MIN, HP_MAX]` (= [0, 10000]). The
  /// leaderboard sorts on this, descending; ties broken by `launchedAt`
  /// ascending (earlier wins). The integer scale was introduced in Epic 1.18
  /// (2026-05-05) — see `HP_COMPOSITE_SCALE` and spec §6.5.
  hp: number;
  /// Active phase used to pick weights.
  phase: Phase;
  /// Pre-momentum composite in [0, 1]. The producer should store this and
  /// pass it back as `priorBaseComposite` next tick to drive momentum.
  baseComposite: number;
  /// Active weights version (`HP_WEIGHTS_VERSION`). Stamped per row so the
  /// indexer can index it on `hpSnapshot` and consumers can audit which set
  /// produced any given score.
  weightsVersion: string;
  /// Snapshot of the feature flags as they were at compute time. Stamped per
  /// row so historical replays can reproduce the score under the exact gate
  /// configuration that was live.
  flagsActive: WeightFlags;
  components: {
    velocity: ComponentBreakdown;
    effectiveBuyers: ComponentBreakdown;
    stickyLiquidity: ComponentBreakdown;
    retention: ComponentBreakdown;
    momentum: ComponentBreakdown;
    holderConcentration: ComponentBreakdown;
  };
}

/// Per spec §6.4.2 the effective-buyers count uses an economic-significance
/// dampening function. `sqrt` is the spec's recommended starting point —
/// gentler at the top end than log, so a cohort with one or two real whales
/// among a healthy distribution still rewards the whales' commitment without
/// letting them dominate. `log` is retained as a toggle for cohorts where a
/// stronger headcount preference is desirable (heavier flattening of large
/// buys; pure breadth signal). Track E v4 validated `sqrt` empirically.
export type EffectiveBuyersFunc = "sqrt" | "log";

export interface ScoringConfig {
  /// Component weights. Default falls back to `LOCKED_WEIGHTS` —
  /// pass an explicit `weights` to override (useful for experiments only;
  /// production must consume the locked set).
  weights?: ScoringWeights;
  phase: Phase;
  /// **Deprecated (Epic 1.22 lock).** Half-life (seconds) for buy-volume time
  /// decay. Engine now reads `VELOCITY_DECAY_HALFLIFE_SEC` from
  /// `constants.ts`; this field is preserved for ScoringConfig type stability
  /// across pre-1.22 callers but no longer affects the velocity formula.
  velocityHalfLifeSec: number;
  /// **Deprecated (Epic 1.22 lock).** Replaced by absolute per-wallet cap
  /// `VELOCITY_PER_WALLET_CAP_WETH` (§6.4.1). The pre-lock engine used a
  /// log-flattening cap with this floor; the locked formula uses an absolute
  /// cap and ignores the floor.
  walletCapFloorWeth: bigint;
  /// **Deprecated (Epic 1.22 lock).** Engine reads `VELOCITY_CHURN_WINDOW_SEC`
  /// from `constants.ts`. Field preserved for type stability.
  churnWindowSec: number;
  /// **Deprecated (Epic 1.22 lock).** Engine reads `EFFECTIVE_BUYERS_DUST_WETH`
  /// from `constants.ts` (locked at 0.001 WETH per spec §6.4.2). Field
  /// preserved for type stability; default value updated to mirror the
  /// locked constant so legacy probes that read this field still produce
  /// spec-correct above/below comparisons.
  buyerDustFloorWeth: bigint;
  /// **Deprecated (Epic 1.22 lock).** Spec §6.4.2 locks the dampening
  /// function to `sqrt`. The legacy `log` toggle is no longer honored;
  /// passing `"log"` has no effect.
  effectiveBuyersFunc: EffectiveBuyersFunc;
  /// Retention split between the long and short anchors. Both must be ≥ 0.
  /// **Active** under the lock — the per-anchor weighted blend is a behavior
  /// knob, not a formula constant.
  retentionLongWeight: number;
  retentionShortWeight: number;
  /// **Deprecated (Epic 1.22 lock).** Sticky-liquidity penalty now reads
  /// `LP_PENALTY_TAU_SEC` / `LP_PENALTY_WINDOW_SEC` from `constants.ts` per
  /// spec §6.4.3. Pre-lock callers can still pass this value as a fallback
  /// multiplier on the aggregate `recentLiquidityRemovedWeth` path (when
  /// `lpEvents` is omitted on `TokenStats`); pre-1.22 default `1.0` is
  /// preserved.
  recentWithdrawalPenalty: number;
  /// Scale: a base-composite delta of `momentumScale` produces the maximum
  /// momentum component score (1.0). Smaller values make momentum more
  /// twitchy. Only consulted when `flags.momentum === true`.
  momentumScale: number;
  /// Hard ceiling on the normalized momentum component (0..1). Default 1.0
  /// (no extra cap beyond normalization × weight). Only consulted when
  /// `flags.momentum === true`.
  momentumCap: number;
  /// Feature-flag bundle. Defaults to `DEFAULT_FLAGS` (matching the env-default
  /// gate state). Override per call when the caller has resolved env values
  /// itself — the scoring package is pure and doesn't read process.env directly.
  flags?: WeightFlags;
}

export const DEFAULT_CONFIG: ScoringConfig = {
  phase: "preFilter",
  velocityHalfLifeSec: 24 * 3600,
  walletCapFloorWeth: 1_000_000_000_000_000n, // 0.001 WETH
  churnWindowSec: 60 * 60,                    // 1 hour
  buyerDustFloorWeth: 1_000_000_000_000_000n, // 0.001 WETH (Epic 1.22 lock; mirrors EFFECTIVE_BUYERS_DUST_WETH)
  effectiveBuyersFunc: "sqrt",
  retentionLongWeight: 0.6,
  retentionShortWeight: 0.4,
  recentWithdrawalPenalty: 1.0,
  momentumScale: 0.10,
  momentumCap: 1.0,
  flags: DEFAULT_FLAGS,
} as const;

/// Resolves the active weights for a phase. Under `HP_WEIGHTS_VERSION =
/// "2026-05-04-v4-locked-int10k-formulas"` every phase returns the same `LOCKED_WEIGHTS` —
/// per-phase differentiation collapsed in v4. Kept as a thin wrapper so a
/// future v5 can revive per-phase weights without forcing a public-API
/// refactor across indexer / oracle / scheduler / web.
export function weightsForPhase(_phase: Phase): ScoringWeights {
  return LOCKED_WEIGHTS;
}

/// Reads the env-default flag values without a `process.env` dependency in
/// the scoring core. Boundary code (indexer, scheduler, oracle) calls this
/// with `process.env` plumbed through so the same evaluator handles both
/// sides; tests pass `{}` and rely on the documented defaults.
export function flagsFromEnv(env: Readonly<Record<string, string | undefined>>): WeightFlags {
  return {
    momentum: parseBool(env.HP_MOMENTUM_ENABLED, DEFAULT_FLAGS.momentum),
    concentration: parseBool(env.HP_CONCENTRATION_ENABLED, DEFAULT_FLAGS.concentration),
  };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}
