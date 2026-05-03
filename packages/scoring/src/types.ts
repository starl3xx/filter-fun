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
/// in lockstep with `LOCKED_WEIGHTS` so a row tagged with this version can
/// always be recomputed by reading the corresponding spec/§6.5 entry.
export const HP_WEIGHTS_VERSION = "2026-05-03-v4-locked" as const;

/// Wall-clock timestamp at which `HP_WEIGHTS_VERSION` activated. Surfaced via
/// the public `/scoring/weights` endpoint so external auditors can verify
/// "what was live when" without reading commit history.
export const HP_WEIGHTS_ACTIVATED_AT = "2026-05-03T00:00:00Z" as const;

/// Spec anchor for the active weights. Surfaced on `/scoring/weights` and
/// referenced from operator runbooks.
export const HP_WEIGHTS_SPEC_REF =
  "https://github.com/starl3xx/filter-fun/blob/main/filter_fun_comprehensive_spec.md#65-hp-component-weights-locked-2026-05-03-per-track-e-v4" as const;

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
  /// Final weighted HP in [0, 1]. The leaderboard sorts on this, descending.
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
  /// Half-life (seconds) for buy-volume time decay. 24h default.
  velocityHalfLifeSec: number;
  /// WETH threshold below which the per-wallet sybil log-cap doesn't kick in.
  walletCapFloorWeth: bigint;
  /// Window (seconds) within which a same-wallet sell after a buy counts as
  /// churn (doubly discounted in net velocity).
  churnWindowSec: number;
  /// Effective-buyers dust floor: wallets with cumulative buy volume below
  /// this contribute exactly zero to the effective-buyers count. Filters out
  /// 1-wei sybils without needing cluster detection.
  buyerDustFloorWeth: bigint;
  /// Dampening function applied to per-wallet buy volume in the
  /// effective-buyers component. Spec §6.4.2 default: `"sqrt"`.
  effectiveBuyersFunc: EffectiveBuyersFunc;
  /// Retention split between the long and short anchors. Both must be ≥ 0.
  retentionLongWeight: number;
  retentionShortWeight: number;
  /// α — multiplier on `recentLiquidityRemoved / avgDepth` for the sticky-liq
  /// penalty. Spec §6.4.3 default: 1.0.
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
  buyerDustFloorWeth: 5_000_000_000_000_000n, // 0.005 WETH
  effectiveBuyersFunc: "sqrt",
  retentionLongWeight: 0.6,
  retentionShortWeight: 0.4,
  recentWithdrawalPenalty: 1.0,
  momentumScale: 0.10,
  momentumCap: 1.0,
  flags: DEFAULT_FLAGS,
} as const;

/// Resolves the active weights for a phase. Under `HP_WEIGHTS_VERSION =
/// "2026-05-03-v4-locked"` every phase returns the same `LOCKED_WEIGHTS` —
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
