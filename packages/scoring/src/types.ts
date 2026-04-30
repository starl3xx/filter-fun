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

  // ── Momentum ────────────────────────────────────────────
  /// Last tick's pre-momentum composite (0..1). Producer-managed state — the
  /// indexer/oracle stores the previous result and feeds it back here. If
  /// unset, momentum is neutral (0.5). The momentum component is bounded so
  /// it can't dominate the final HP regardless of how large the delta is.
  priorBaseComposite?: number;
}

/// Filter-week phases that influence weighting.
export type Phase = "preFilter" | "finals";

export interface ScoringWeights {
  velocity: number;
  effectiveBuyers: number;
  stickyLiquidity: number;
  retention: number;
  momentum: number;
}

/// Default phase-agnostic weights — used when caller doesn't specify a phase.
export const DEFAULT_WEIGHTS: ScoringWeights = {
  velocity: 0.35,
  effectiveBuyers: 0.20,
  stickyLiquidity: 0.20,
  retention: 0.15,
  momentum: 0.10,
} as const;

/// Pre-filter weights: emphasize discovery and breadth of participation —
/// velocity and effective buyers are higher; conviction (retention, sticky
/// liquidity) is lower. New tokens with rising real demand can climb fast.
export const PRE_FILTER_WEIGHTS: ScoringWeights = {
  velocity: 0.40,
  effectiveBuyers: 0.25,
  stickyLiquidity: 0.15,
  retention: 0.10,
  momentum: 0.10,
} as const;

/// Finals weights (spec §6.5): emphasize conviction — sticky liquidity and
/// retention rise sharply (15→25, 10→20) at the expense of velocity (40→30)
/// and effective buyers (25→15). Late surges still count via momentum, but
/// coasting on staked liquidity + loyal holders is rewarded. Discovery
/// (velocity + effective buyers = 0.45) and conviction (sticky + retention
/// = 0.45) sit at equal *group* weight — finals isn't a wholesale conviction
/// override of pre-filter (65/25 discovery-favoring); it's a *rebalance* to
/// parity. The within-group preference shifts too: velocity stays above
/// effective buyers (30 > 15) so a finalist with broad sustained buy
/// pressure still climbs, and sticky liq edges retention (25 > 20) so LP
/// commitment outranks holder count.
export const FINALS_WEIGHTS: ScoringWeights = {
  velocity: 0.30,
  effectiveBuyers: 0.15,
  stickyLiquidity: 0.25,
  retention: 0.20,
  momentum: 0.10,
} as const;

/// UI-facing labels. Keep these short, plain-English, and free of math —
/// the leaderboard tooltips render these directly.
export const COMPONENT_LABELS = {
  velocity: "Buying activity",
  effectiveBuyers: "Real participants",
  stickyLiquidity: "Liquidity strength",
  retention: "Holder conviction",
  momentum: "Momentum",
} as const;

export interface ComponentBreakdown {
  /// Normalized [0, 1] component score across the cohort.
  score: number;
  /// Weight applied to this component when computing the final HP.
  weight: number;
  /// Plain-English label for UI.
  label: string;
}

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
  components: {
    velocity: ComponentBreakdown;
    effectiveBuyers: ComponentBreakdown;
    stickyLiquidity: ComponentBreakdown;
    retention: ComponentBreakdown;
    momentum: ComponentBreakdown;
  };
}

/// Per spec §6.4.2 the effective-buyers count uses an economic-significance
/// dampening function. `sqrt` is the spec's recommended starting point —
/// gentler at the top end than log, so a cohort with one or two real whales
/// among a healthy distribution still rewards the whales' commitment without
/// letting them dominate. `log` is retained as a toggle for cohorts where a
/// stronger headcount preference is desirable (heavier flattening of large
/// buys; pure breadth signal). Track E will validate the choice empirically.
export type EffectiveBuyersFunc = "sqrt" | "log";

export interface ScoringConfig {
  /// Component weights. Default falls back to the active phase's weights —
  /// pass an explicit `weights` to override (useful for experiments).
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
  /// penalty. Spec §6.4.3 default: 1.0 (a 100%-of-depth recent withdrawal
  /// fully zeroes the sticky-liq score). Lower values soften the penalty.
  /// **Indexer responsibility:** protocol-controlled LP unwinds during filter
  /// events are not market signal and should be excluded from
  /// `recentLiquidityRemovedWeth` upstream of scoring (filter by tx
  /// originator). Scoring trusts the input; it can't tell system actions
  /// apart from user actions on its own.
  recentWithdrawalPenalty: number;
  /// Scale: a base-composite delta of `momentumScale` produces the maximum
  /// momentum component score (1.0). Smaller values make momentum more
  /// twitchy. The post-normalization momentum is then clipped by
  /// `momentumCap` and finally weighted (default 0.10), so even a max surge
  /// can contribute at most `momentumCap × momentum.weight` to HP.
  momentumScale: number;
  /// Hard ceiling on the normalized momentum component (0..1). Default 1.0
  /// (no extra cap beyond normalization × weight). Operators can tighten
  /// this — e.g. 0.5 caps momentum's HP contribution to half its weight —
  /// if empirical data shows momentum-driven rank flips. The cap applies
  /// only to tokens with a prior base composite (i.e. real momentum signal);
  /// first-tick tokens with no history retain the 0.5 neutral baseline
  /// regardless of `momentumCap`, so tightening the cap below 0.5 never
  /// retroactively punishes a fresh token for lacking history.
  momentumCap: number;
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
} as const;

/// Resolves the active weights for a phase. Falls back to DEFAULT_WEIGHTS if
/// phase is unrecognized (defensive).
export function weightsForPhase(phase: Phase): ScoringWeights {
  if (phase === "preFilter") return PRE_FILTER_WEIGHTS;
  if (phase === "finals") return FINALS_WEIGHTS;
  return DEFAULT_WEIGHTS;
}
