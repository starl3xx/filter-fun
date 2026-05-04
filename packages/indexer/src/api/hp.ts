/// HP composition layer.
///
/// Bridges between the indexer's row shape and the scoring package's `TokenStats` input.
///
/// **Known gap (genesis indexer).** The current schema indexes contract events (lifecycle
/// + fee accruals + claims) but does NOT yet index swap / transfer events, so the per-wallet
/// buy & sell streams that drive `velocity` / `effectiveBuyers` / `retention` are unavailable.
/// Until Epic 1.3 part 2/3 (or a dedicated indexer expansion) lands, the inputs come back as
/// empty sets / zero balances, and `score()` produces a degenerate cohort where every token
/// gets the same uniform score. The shape stays correct (HP in [0,1], components present
/// with their phase weights) so the UI can be developed against it; the absolute values are
/// stand-ins until trading data is indexed.
///
/// The pure function `tokenStatsFromRows` lives separately from the route handler so future
/// indexer expansions can be tested via fixtures without spinning up Ponder.

import {
  DEFAULT_CONFIG,
  flagsFromEnv,
  score,
  type Address,
  type Phase,
  type ScoredToken,
  type ScoringConfig,
  type TokenStats,
  type WeightFlags,
} from "@filter-fun/scoring";

export interface TokenRow {
  id: `0x${string}`; // token address
  liquidationProceeds: bigint | null;
  /// Unix-seconds the token was deployed (`token.createdAt`). Drives the
  /// Epic 1.18 tie-break — when two tokens land on the same integer HP, the
  /// earlier-launched one ranks higher. Optional during the migration so
  /// callers that haven't been updated yet still typecheck; the public
  /// `/tokens` query path always populates it.
  createdAt?: bigint;
}

/// Builds a minimal `TokenStats` from indexed data. Today this is largely empty — see the
/// "known gap" note above — but keeping the interface intact lets future PRs swap real
/// trade / holder data in without touching the route handler.
export function tokenStatsFromRows(row: TokenRow): TokenStats {
  return {
    token: row.id as Address,
    volumeByWallet: new Map(),
    buys: [],
    sells: [],
    // `liquidationProceeds` is the WETH yielded when a filtered token's LP was unwound.
    // For an active token it's null; we surface 0 as the depth so HP doesn't reward
    // tokens for their post-mortem WETH proceeds.
    liquidityDepthWeth: 0n,
    currentHolders: new Set(),
    holdersAtRetentionAnchor: new Set(),
    launchedAt: row.createdAt,
  };
}

export function pickScoringPhase(apiPhase: string): Phase {
  // Spec §6.5 collapses contract phases to two scoring phases:
  //   pre-cut (launch + competition) → preFilter
  //   post-cut (finals + settled)    → finals
  if (apiPhase === "finals" || apiPhase === "settled") return "finals";
  return "preFilter";
}

/// Resolves the live feature flags from process.env. Cached at module scope —
/// flag values are read once at indexer boot and don't hot-swap during a run.
/// Override per-call via `scoreCohort({flags})` for tests.
export function liveFlags(): WeightFlags {
  return flagsFromEnv(process.env);
}

/// Public entry point used by the `/tokens` route. Composes `tokenStatsFromRows` over the
/// cohort, calls `score()` with phase-derived weights, and returns the scored array indexed
/// by token address for downstream lookup.
///
/// Feature flags (`HP_MOMENTUM_ENABLED`, `HP_CONCENTRATION_ENABLED`) are read
/// from `process.env` via `liveFlags()` unless the caller passes an explicit
/// `flags` override in `config`. The boundary lives here (not inside the
/// scoring package) so the scoring core stays pure.
export function scoreCohort(
  rows: ReadonlyArray<TokenRow>,
  apiPhase: string,
  currentTime: bigint,
  config: Partial<ScoringConfig> = {},
): Map<string, ScoredToken> {
  const phase = pickScoringPhase(apiPhase);
  const stats = rows.map(tokenStatsFromRows);
  const flags = config.flags ?? liveFlags();
  const scored = score(stats, currentTime, {...DEFAULT_CONFIG, phase, flags, ...config});
  const out = new Map<string, ScoredToken>();
  for (const s of scored) out.set(s.token.toLowerCase(), s);
  return out;
}
