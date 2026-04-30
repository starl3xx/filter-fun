/// Pure handler implementations.
///
/// `src/api/index.ts` does the Ponder-flavored Drizzle queries and adapts the results into
/// the small `ApiQueries` shape below. Everything else — composition, scoring, response
/// shaping, error responses — lives here, behind the queries interface, so vitest can drive
/// it with hand-rolled fixture queries instead of a running Ponder.

import {
  buildSeasonResponse,
  buildTokensResponse,
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

export interface ApiQueries {
  /// Latest season the indexer has seen (highest seasonId), or null if none.
  latestSeason: () => Promise<SeasonRow | null>;
  /// Public-launch count for `seasonId` (excludes `isProtocolLaunched` rows).
  publicLaunchCount: (seasonId: bigint) => Promise<number>;
  /// All tokens belonging to `seasonId`. Order isn't guaranteed; the builder sorts by rank.
  tokensInSeason: (seasonId: bigint) => Promise<TokenRow[]>;
  /// Find a token by address (lowercased), or null if absent.
  tokenByAddress: (addr: `0x${string}`) => Promise<TokenDetailRow | null>;
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

export async function getSeasonHandler(
  q: ApiQueries,
): Promise<ApiResult<SeasonResponse>> {
  const row = await q.latestSeason();
  if (!row) return err(404, "no season indexed yet");
  const launchCount = await q.publicLaunchCount(row.id);
  return ok(buildSeasonResponse(row, launchCount));
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
  return ok(buildTokensResponse(tokenRows, scored, apiPhase));
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

export function isAddressLike(s: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(s);
}
