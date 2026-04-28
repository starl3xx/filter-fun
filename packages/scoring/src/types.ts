export type Address = `0x${string}`;

/// Per-token aggregated metrics produced by the indexer (or test fixtures).
/// All `bigint` amounts are in raw token units.
export interface TokenStats {
  /// Token contract address.
  token: Address;
  /// Cumulative buy volume per wallet, in WETH raw units (1e18).
  volumeByWallet: Map<Address, bigint>;
  /// Each individual buy, time-stamped — used for time-decayed velocity.
  buys: ReadonlyArray<{wallet: Address; ts: bigint; amountWeth: bigint}>;
  /// Current LP base-asset depth (WETH) — proxy for recoverable settlement value.
  liquidityDepthWeth: bigint;
  /// Set of wallets currently holding any positive balance.
  currentHolders: ReadonlySet<Address>;
  /// Holders at a fixed earlier snapshot (e.g. 24h ago) — used for retention.
  holdersAtRetentionAnchor: ReadonlySet<Address>;
}

export interface ScoringWeights {
  volumeVelocity: number;
  uniqueBuyers: number;
  liquidityDepth: number;
  retention: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  volumeVelocity: 0.4,
  uniqueBuyers: 0.25,
  liquidityDepth: 0.2,
  retention: 0.15,
} as const;

export interface ScoreComponents {
  /// Each component is normalized to [0, 1] across the cohort.
  volumeVelocity: number;
  uniqueBuyers: number;
  liquidityDepth: number;
  retention: number;
}

export interface ScoredToken {
  token: Address;
  rank: number;
  score: number;
  components: ScoreComponents;
}

export interface ScoringConfig {
  weights: ScoringWeights;
  /// Half-life (seconds) for buy-volume time decay. 24h default.
  velocityHalfLifeSec: number;
  /// WETH threshold below which per-wallet log-cap doesn't kick in.
  walletCapFloorWeth: bigint;
}

export const DEFAULT_CONFIG: ScoringConfig = {
  weights: DEFAULT_WEIGHTS,
  velocityHalfLifeSec: 24 * 3600,
  walletCapFloorWeth: 1_000_000_000_000_000n, // 0.001 WETH
} as const;
