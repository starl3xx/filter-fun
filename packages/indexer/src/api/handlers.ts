/// Pure handler implementations.
///
/// `src/api/index.ts` does the Ponder-flavored Drizzle queries and adapts the results into
/// the small `ApiQueries` shape below. Everything else — composition, scoring, response
/// shaping, error responses — lives here, behind the queries interface, so vitest can drive
/// it with hand-rolled fixture queries instead of a running Ponder.
///
/// === Endpoint status convention (Audit H-2, Phase 1, 2026-05-01) ===
///
/// Every endpoint in this file (and `profile.ts`) follows one rule, picked deliberately to
/// keep uptime monitors + SDK consumers honest:
///
///   - Collections + season/status endpoints  → 200 with empty/null/sentinel payload
///   - Named singletons (`/token/:address`)   → 404 for unknown identifiers
///   - `/profile/:address`                    → 200/empty (privacy-driven exception, §22)
///
/// Concretely:
///   /season              200 + {status: "not-ready", season: null}  when no season indexed
///   /tokens              200 + []                                   when no season exists
///   /token/:address      404                                        when address unknown
///   /profile/:address    200 + empty profile                        always (privacy)
///
/// Why the 200/`status: "not-ready"` shape on `/season`: pre-mainnet there will be windows
/// where no season is indexed yet (post-deploy, between weeks). A 404 there confuses uptime
/// checks (they can't distinguish "indexer down" from "no season yet") and forces every
/// consumer to special-case a 404. The status field gives clients a single field to gate on.

import {
  buildSeasonResponse,
  buildTokensResponse,
  isAddressLike,
  tickerWithDollar,
  type SeasonResponse,
  type SeasonRow,
  type TokenResponse,
  type TokenRow,
} from "./builders.js";
import {scoreCohort} from "./hp.js";
import {toApiPhase} from "./phase.js";

export interface TokenDetailRow extends TokenRow {
  name: string;
  seasonId: bigint;
  isProtocolLaunched: boolean;
}

/// Bag-lock fact for a single token, joined onto the /tokens response. The shape
/// matches the indexer's `creator_lock` row (`unlockTimestamp` + `creator`); the
/// builder adds `isLocked` (a wall-clock comparison) at response time.
export interface BagLockRow {
  token: `0x${string}`;
  creator: `0x${string}`;
  unlockTimestamp: bigint;
}

export interface ApiQueries {
  /// Latest season the indexer has seen (highest seasonId), or null if none.
  latestSeason: () => Promise<SeasonRow | null>;
  /// Public-launch count for `seasonId` (excludes `isProtocolLaunched` rows).
  publicLaunchCount: (seasonId: bigint) => Promise<number>;
  /// All tokens belonging to `seasonId`. Order isn't guaranteed; the builder sorts by rank.
  tokensInSeason: (seasonId: bigint) => Promise<TokenRow[]>;
  /// Find a token by address (lowercased), or null if absent.
  tokenByAddress: (addr: `0x${string}`) => Promise<TokenDetailRow | null>;
  /// Bag-lock rows for the supplied tokens. Tokens absent from the result map have no
  /// recorded commitment (legacy or non-locking creators).
  bagLocksForTokens: (
    tokens: ReadonlyArray<`0x${string}`>,
  ) => Promise<BagLockRow[]>;
}

export interface ApiResult<T> {
  status: number;
  body: T | {error: string};
}

export function ok<T>(body: T): ApiResult<T> {
  return {status: 200, body};
}

export function err(status: number, message: string): ApiResult<never> {
  return {status, body: {error: message}};
}

// ============================================================ /season

/// Audit H-2: discriminated-union response. `status: "ready"` carries the full
/// SeasonResponse; `status: "not-ready"` carries `season: null` and signals "no season
/// indexed yet" without a 404. Web app gates on `status` before reading `season`.
export type SeasonEnvelope =
  | {status: "ready"; season: SeasonResponse}
  | {status: "not-ready"; season: null};

export async function getSeasonHandler(
  q: ApiQueries,
): Promise<ApiResult<SeasonEnvelope>> {
  const row = await q.latestSeason();
  if (!row) {
    // Audit H-2 (Phase 1, 2026-05-01): pre-fix this returned 404 "no season indexed yet".
    // 404 confuses uptime monitors (looks like the endpoint is missing) and forces every
    // SDK consumer to special-case 404 → empty. 200 with the {status, season} envelope
    // gives clients a single field to gate on while keeping the endpoint observably alive.
    return ok({status: "not-ready", season: null});
  }
  const launchCount = await q.publicLaunchCount(row.id);
  return ok({status: "ready", season: buildSeasonResponse(row, launchCount)});
}

// ============================================================ /tokens

export async function getTokensHandler(
  q: ApiQueries,
  /// Caller-injected clock so tests can pin time deterministically. The route handler
  /// passes `BigInt(Math.floor(Date.now() / 1000))`.
  nowSec: bigint,
): Promise<ApiResult<TokenResponse[]>> {
  const seasonRow = await q.latestSeason();
  if (!seasonRow) {
    // No season → empty cohort. Spec §26.4 doesn't define this edge but the leaderboard's
    // happy path is "render an empty list before week 1 opens", not a 404.
    return ok([]);
  }
  const apiPhase = toApiPhase(seasonRow.phase);
  const tokenRows = await q.tokensInSeason(seasonRow.id);
  const scored = scoreCohort(
    tokenRows.map((r) => ({id: r.id, liquidationProceeds: r.liquidationProceeds})),
    apiPhase,
    nowSec,
  );
  // Bag-lock surface: one bulk fetch keyed by all token ids in the cohort, mapped down
  // to the lowercased-token-address index the builder consumes. We pass the request
  // wall-clock through so a freshly-expired lock immediately surfaces as unlocked.
  const lockRows = await q.bagLocksForTokens(tokenRows.map((r) => r.id));
  const bagLockByToken = new Map<string, {creator: `0x${string}`; unlockTimestamp: bigint}>();
  for (const lr of lockRows) {
    bagLockByToken.set(lr.token.toLowerCase(), {
      creator: lr.creator,
      unlockTimestamp: lr.unlockTimestamp,
    });
  }
  return ok(buildTokensResponse(tokenRows, scored, apiPhase, bagLockByToken, nowSec));
}

// ============================================================ /token/:address

export interface TokenDetailResponse {
  token: `0x${string}`;
  ticker: string;
  name: string;
  seasonId: number;
  isProtocolLaunched: boolean;
  isFinalist: boolean;
  liquidated: boolean;
}

export async function getTokenDetailHandler(
  q: ApiQueries,
  rawAddress: string,
): Promise<ApiResult<TokenDetailResponse>> {
  const addr = rawAddress.toLowerCase();
  if (!isAddressLike(addr)) return err(400, "invalid address");
  const row = await q.tokenByAddress(addr as `0x${string}`);
  if (!row) return err(404, "unknown token");
  return ok({
    token: row.id,
    ticker: tickerWithDollar(row.symbol),
    name: row.name,
    seasonId: Number(row.seasonId),
    isProtocolLaunched: row.isProtocolLaunched,
    isFinalist: row.isFinalist,
    liquidated: row.liquidated,
  });
}

/// Re-export the centralized validator so `import {isAddressLike} from "./handlers.js"`
/// (used in tests) keeps working without sprawling import-path churn.
export {isAddressLike} from "./builders.js";

// ============================================================ /readiness (Audit H-4)

/// Audit H-4 (Phase 1, 2026-05-01): readiness probe distinct from Ponder's /health.
/// `/health` returns 200 as soon as the HTTP server is up — useful for liveness checks
/// (Railway uses it) but blind to indexer sync state. `/readiness` returns 200 only when
/// the indexer has at least one season indexed AND the live-event pipeline (TickEngine)
/// is running.
///
/// The route returns 503 (Service Unavailable) on a `false` ready state so a Kubernetes-
/// style readiness gate routes traffic away during startup / between sync drops without
/// killing the process.

export interface ReadinessChecks {
  latestSeason: boolean;
  tickEngine: boolean;
  latestSeasonId: number | null;
}

export interface ReadinessResponse {
  ready: boolean;
  checks: ReadinessChecks;
}

/// Probes that drive the readiness verdict. Kept abstract so vitest can drive the handler
/// with synthetic states (no season, season + tick stopped, season + tick running) without
/// needing a live Ponder DB or SSE engine.
export interface ReadinessProbes {
  latestSeasonId: () => Promise<number | null>;
  tickEngineRunning: () => boolean;
}

export async function getReadinessHandler(p: ReadinessProbes): Promise<ApiResult<ReadinessResponse>> {
  const seasonId = await p.latestSeasonId();
  const hasSeason = seasonId !== null;
  const tickRunning = p.tickEngineRunning();
  const ready = hasSeason && tickRunning;
  const body: ReadinessResponse = {
    ready,
    checks: {
      latestSeason: hasSeason,
      tickEngine: tickRunning,
      latestSeasonId: seasonId,
    },
  };
  // 503 on not-ready is the load-balancer-friendly status. A 200/false combo tempts
  // probes to ignore the body and route traffic anyway.
  return {status: ready ? 200 : 503, body};
}
