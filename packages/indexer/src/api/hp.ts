/// HP composition layer.
///
/// Bridges between the indexer's row shape and the scoring package's `TokenStats` input.
/// Epic 1.22b — `tokenStatsFromRows` is now backed by real swap + holderBalance data
/// (the genesis-era stub is gone). The async `scoreCohort` does ONE bulk query per table
/// per cohort, groups by token, and feeds per-token slices to the pure projection.
///
/// **Why pre-fetch in `scoreCohort` instead of per-token in `tokenStatsFromRows`.**
/// HP is recomputed on every swap (spec §6.8 latency budget), and a 12-token cohort
/// would otherwise issue 24 queries (12 swap + 12 holder) per recompute. Bulk-querying
/// once and partitioning in memory keeps the writer well under the 3s SLA. The pure
/// projection stays sync + side-effect-free so it can be unit-tested with fixtures.
///
/// **Retention anchor approximation.** Spec §6.4.4 calls for "holders at T−24h."
/// We don't have a transfer event log, but `holderBalance.firstSeenAt` (Epic 1.22b)
/// captures when each wallet first received a credit. We approximate
/// `holdersAtRetentionAnchor = {w : firstSeenAt(w) ≤ now − retentionLongSec}` —
/// "wallets that already existed at the anchor." A wallet that held at T−24h then
/// fully exited and is now at zero is currently excluded (since we filter to
/// balance > 0); this slightly *over-counts* retention vs the spec's strict reading
/// (the strict reading would put exited wallets in the anchor denominator and the
/// intersection numerator unchanged → lower ratio). Documented as a known limitation
/// — a future PR can add a transfer log for exact reconstruction.

import {and, eq, gt, gte, inArray} from "@ponder/core";

import {holderBalance, swap} from "../../ponder.schema";
import {
  DEFAULT_CONFIG,
  flagsFromEnv,
  score,
  VELOCITY_LOOKBACK_SEC,
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

/// Per-token slice of pre-fetched indexer rows. The bulk fetcher in
/// `scoreCohort` partitions cohort-wide queries by token and hands each token
/// its slice; the pure projection consumes only this struct (no DB access)
/// so it can be exercised with fixtures.
export interface TokenProjectionInputs {
  /// In-window swaps for this token, sorted ascending by `blockTimestamp`.
  /// Already filtered to `>= now - VELOCITY_LOOKBACK_SEC`.
  swaps: ReadonlyArray<{
    taker: `0x${string}`;
    side: string; // "BUY" | "SELL"
    wethValue: bigint;
    blockTimestamp: bigint;
  }>;
  /// Current per-(holder, token) rows with `balance > 0`. Used for current
  /// holders, holderBalances (HHI), totalSupply derivation, and (via
  /// `firstSeenAt`) the retention anchor.
  holders: ReadonlyArray<{
    holder: `0x${string}`;
    balance: bigint;
    firstSeenAt: bigint;
  }>;
}

/// Retention anchor windows. The spec's "long anchor" is 24h; the optional
/// "short anchor" is 1h. `tokenStatsFromRows` derives anchor sets from
/// `firstSeenAt` against (currentTime - longSec) / (currentTime - shortSec).
export const RETENTION_LONG_SEC = 24n * 3600n;
export const RETENTION_SHORT_SEC = 3600n;

/// Pure projection: indexer rows → `TokenStats`. Synchronous, no DB access.
/// Tests pass synthetic `TokenProjectionInputs` shapes; production code
/// composes via the bulk fetcher in `scoreCohort`.
export function tokenStatsFromRows(
  row: TokenRow,
  projection: TokenProjectionInputs,
  currentTime: bigint,
): TokenStats {
  // Aggregate per-wallet buy volume (drives effectiveBuyers + the per-wallet
  // velocity cap). We keep all in-window swaps for the buys/sells streams the
  // velocity formula iterates over.
  const volumeByWallet = new Map<Address, bigint>();
  const buys: Array<{wallet: Address; ts: bigint; amountWeth: bigint}> = [];
  const sells: Array<{wallet: Address; ts: bigint; amountWeth: bigint}> = [];
  for (const s of projection.swaps) {
    const wallet = s.taker.toLowerCase() as Address;
    if (s.side === "BUY") {
      buys.push({wallet, ts: s.blockTimestamp, amountWeth: s.wethValue});
      volumeByWallet.set(wallet, (volumeByWallet.get(wallet) ?? 0n) + s.wethValue);
    } else {
      sells.push({wallet, ts: s.blockTimestamp, amountWeth: s.wethValue});
    }
  }

  // Holders: anyone with balance > 0 right now is a current holder. The HHI
  // input (`holderBalances`) is just the balance column for each.
  const currentHolders = new Set<Address>();
  const holderBalances: bigint[] = [];
  let totalSupply = 0n;
  const balanceByHolder = new Map<Address, bigint>();
  const firstSeenByHolder = new Map<Address, bigint>();
  for (const h of projection.holders) {
    if (h.balance <= 0n) continue;
    const w = h.holder.toLowerCase() as Address;
    currentHolders.add(w);
    holderBalances.push(h.balance);
    totalSupply += h.balance;
    balanceByHolder.set(w, h.balance);
    firstSeenByHolder.set(w, h.firstSeenAt);
  }

  // Retention anchor: wallets that first received a credit ≥ retentionLongSec
  // ago. See module-level "anchor approximation" doc — this is a tractable
  // proxy for "held at T-24h."
  const longAnchorTs = currentTime - RETENTION_LONG_SEC;
  const shortAnchorTs = currentTime - RETENTION_SHORT_SEC;
  const holdersAtRetentionAnchor = new Set<Address>();
  const holdersAtRecentAnchor = new Set<Address>();
  const holderBalancesAtRetentionAnchor = new Map<Address, bigint>();
  for (const [w, firstSeen] of firstSeenByHolder) {
    if (firstSeen <= longAnchorTs) {
      holdersAtRetentionAnchor.add(w);
      // Approximation: use current balance for the dust-supply filter. A
      // wallet that was a whale at the anchor and has since sold down would
      // be excluded under this rule (under-counts retention slightly); the
      // strict spec would consult the anchor balance directly.
      holderBalancesAtRetentionAnchor.set(w, balanceByHolder.get(w) ?? 0n);
    }
    if (firstSeen <= shortAnchorTs) {
      holdersAtRecentAnchor.add(w);
    }
  }

  return {
    token: row.id as Address,
    volumeByWallet,
    buys,
    sells,
    // Sticky-liquidity falls back to the aggregate path (engine reads
    // `liquidityDepthWeth` / `avgLiquidityDepthWeth` / `recentLiquidityRemovedWeth`).
    // Per-event LP timeline (`lpEvents`) is deferred — wiring V4
    // ModifyLiquidity is its own scope and the engine's aggregate fallback is
    // already the §6.4.3 path under that input shape. liquidationProceeds is
    // post-mortem; we keep depth at zero so a filtered token can't claim
    // liquidity credit from its post-cut WETH yield.
    liquidityDepthWeth: 0n,
    currentHolders,
    holdersAtRetentionAnchor,
    holdersAtRecentAnchor: holdersAtRecentAnchor.size > 0 ? holdersAtRecentAnchor : undefined,
    holderBalances,
    holderBalancesAtRetentionAnchor:
      holderBalancesAtRetentionAnchor.size > 0 ? holderBalancesAtRetentionAnchor : undefined,
    holderFirstSeenAt: firstSeenByHolder.size > 0 ? firstSeenByHolder : undefined,
    totalSupply: totalSupply > 0n ? totalSupply : undefined,
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

/// Drizzle-shaped query handle. Both Ponder's writer-side `context.db.sql`
/// and the API/SSE-side `ApiContext["db"]` satisfy this — they're the same
/// `pg-core` query builder. We intentionally don't import the ponder type
/// to keep the helper testable with a hand-rolled fake.
export interface ProjectionDb {
  select: (...args: any[]) => any;
}

/// Bulk-fetches swaps + holderBalances for the cohort and groups by token.
/// Single source of truth for the projection-fetch SQL — both the writer-
/// side path (`scoreCohortFromContext` via `fetchProjectionInputs`) and the
/// HTTP/SSE adapters in `api/index.ts` + `api/events/index.ts` route through
/// this. Bugbot M (PR #97): consolidating here prevents the three call
/// sites from silently diverging on a filter or column change.
export async function fetchProjectionInputsFromDb(
  db: ProjectionDb,
  tokenAddrs: ReadonlyArray<`0x${string}`>,
  currentTime: bigint,
): Promise<Map<string, TokenProjectionInputs>> {
  const out = new Map<string, TokenProjectionInputs>();
  if (tokenAddrs.length === 0) return out;
  for (const a of tokenAddrs) {
    out.set(a.toLowerCase(), {swaps: [], holders: []});
  }

  const lookbackStart = currentTime - BigInt(VELOCITY_LOOKBACK_SEC);
  const tokenAddrsMutable = [...tokenAddrs];

  // Bulk swap fetch: one query covers the cohort. Drizzle's inArray is
  // PG-side; the result set is bounded by the 96h window.
  const swapRows = await db
    .select()
    .from(swap)
    .where(and(inArray(swap.token, tokenAddrsMutable), gte(swap.blockTimestamp, lookbackStart)));
  for (const s of swapRows as Array<{
    token: `0x${string}`;
    taker: `0x${string}`;
    side: string;
    wethValue: bigint;
    blockTimestamp: bigint;
  }>) {
    const slot = out.get(s.token.toLowerCase());
    if (!slot) continue;
    (slot.swaps as Array<{
      taker: `0x${string}`;
      side: string;
      wethValue: bigint;
      blockTimestamp: bigint;
    }>).push({
      taker: s.taker,
      side: s.side,
      wethValue: s.wethValue,
      blockTimestamp: s.blockTimestamp,
    });
  }

  // Bulk holderBalance fetch: balance > 0 only (exited wallets contribute
  // nothing under the projection's current-holder definition).
  const holderRows = await db
    .select()
    .from(holderBalance)
    .where(
      and(inArray(holderBalance.token, tokenAddrsMutable), gt(holderBalance.balance, 0n)),
    );
  for (const h of holderRows as Array<{
    token: `0x${string}`;
    holder: `0x${string}`;
    balance: bigint;
    firstSeenAt: bigint;
  }>) {
    const slot = out.get(h.token.toLowerCase());
    if (!slot) continue;
    (slot.holders as Array<{holder: `0x${string}`; balance: bigint; firstSeenAt: bigint}>).push({
      holder: h.holder,
      balance: h.balance,
      firstSeenAt: h.firstSeenAt,
    });
  }

  return out;
}

/// Writer-side wrapper: extracts `context.db.sql` and delegates to the
/// shared helper. Kept as a named export so the recompute writer's import
/// pattern is unchanged.
export async function fetchProjectionInputs(
  context: any,
  tokenAddrs: ReadonlyArray<`0x${string}`>,
  currentTime: bigint,
): Promise<Map<string, TokenProjectionInputs>> {
  return fetchProjectionInputsFromDb(context.db.sql, tokenAddrs, currentTime);
}

/// Public entry point used by the `/tokens` route + the recompute writer.
/// Composes `tokenStatsFromRows` over the cohort, calls `score()` with
/// phase-derived weights, and returns the scored array indexed by token
/// address for downstream lookup.
///
/// Feature flags (`HP_MOMENTUM_ENABLED`, `HP_CONCENTRATION_ENABLED`) are read
/// from `process.env` via `liveFlags()` unless the caller passes an explicit
/// `flags` override in `config`. The boundary lives here (not inside the
/// scoring package) so the scoring core stays pure.
///
/// Epic 1.22b — `projections` is the pre-fetched per-token slice map. Two
/// production sources:
///   - Recompute writer: `await fetchProjectionInputs(context, ...)`
///   - HTTP `/tokens` handler: built from the `ApiQueries.projectionInputsForCohort`
///     adapter so tests can inject synthetic maps without a Ponder context.
/// Tests pass synthetic Maps (or empty) to drive specific cohort shapes.
export function scoreCohort(
  rows: ReadonlyArray<TokenRow>,
  apiPhase: string,
  currentTime: bigint,
  projections: ReadonlyMap<string, TokenProjectionInputs>,
  config: Partial<ScoringConfig> = {},
): Map<string, ScoredToken> {
  const phase = pickScoringPhase(apiPhase);
  const empty: TokenProjectionInputs = {swaps: [], holders: []};
  const stats = rows.map((r) =>
    tokenStatsFromRows(r, projections.get(r.id.toLowerCase()) ?? empty, currentTime),
  );
  const flags = config.flags ?? liveFlags();
  const scored = score(stats, currentTime, {...DEFAULT_CONFIG, phase, flags, ...config});
  const out = new Map<string, ScoredToken>();
  for (const s of scored) out.set(s.token.toLowerCase(), s);
  return out;
}

/// Convenience wrapper that combines `fetchProjectionInputs` + `scoreCohort`
/// for callers that already have a Ponder context (the recompute writer +
/// the periodic block-tick handler). HTTP route handlers go through
/// `scoreCohort` directly with a projection map sourced from `ApiQueries`.
export async function scoreCohortFromContext(
  context: any,
  rows: ReadonlyArray<TokenRow>,
  apiPhase: string,
  currentTime: bigint,
  config: Partial<ScoringConfig> = {},
): Promise<Map<string, ScoredToken>> {
  const projections = await fetchProjectionInputs(
    context,
    rows.map((r) => r.id),
    currentTime,
  );
  return scoreCohort(rows, apiPhase, currentTime, projections, config);
}
