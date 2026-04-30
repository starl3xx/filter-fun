/// HTTP API routes — Epic 1.3 (parts 1/3 + 3/3).
///
/// Mounts on Ponder's built-in Hono server (default port 42069) via `ponder.get`. Endpoints:
///
///   GET /season             — current season state, cadence anchors, prize pools
///   GET /tokens             — ranked cohort with HP + components + status + market data
///   GET /token/:address     — minimal per-token detail (used by the leaderboard token card)
///   GET /profile/:address   — wallet-level stats: createdTokens + claim sums + badges
///
/// Liveness (`/health`), readiness (`/ready`), and metrics (`/metrics`) are served by
/// Ponder itself — they're reserved paths and adding our own here would fail validation.
/// `/health` returns 200 as soon as the HTTP server is up (independent of indexer sync),
/// which is what Railway's healthcheck targets via `railway.json`.
///
/// Cross-cutting concerns wired in here:
///   - **Per-IP rate limit** — token bucket on every GET; `/events` is governed separately
///     by a connection cap (see `events/index.ts`).
///   - **Read-through cache** — `/season`, `/tokens`, `/profile` are wrapped in an LRU+TTL
///     cache. `X-Cache: HIT|MISS|BYPASS` reflects which branch served the request.
///   - **Headers** — `RateLimit-Remaining` on every response, `Retry-After` on 429.
///
/// Route handlers stay thin: they translate Drizzle queries into the small `ApiQueries`
/// / `ProfileQueries` shapes that pure handlers consume. The middleware module owns the
/// shared rate-limit + cache singletons so the SSE route shares the same per-IP budget.

import {ponder, type ApiContext} from "@/generated";
import {and, count, desc, eq} from "@ponder/core";

import {bonusClaim, rolloverClaim, season, token} from "../../ponder.schema";

import {cached} from "./cache.js";
import {
  getSeasonHandler,
  getTokenDetailHandler,
  getTokensHandler,
  type ApiQueries,
  type TokenDetailRow,
} from "./handlers.js";
import {
  applyGetRateLimit,
  profileCacheKey,
  profileResponseCache,
  seasonResponseCache,
  SEASON_CACHE_KEY,
  shouldBypassCache,
  tokensResponseCache,
  TOKENS_CACHE_KEY,
  type MwContext,
} from "./middleware.js";
import {
  getProfileHandler,
  type ClaimSums,
  type CreatedTokenRow,
  type ProfileQueries,
  type ProfileResponse,
} from "./profile.js";

/// Ponder's typed route context narrows Hono's generics to `(schema, route, BlankInput)`,
/// which strips `c.header()` from the surface. The events route works around this with
/// `as unknown as Context` (Hono's wide form); we pin a structural `MwContext` shim instead
/// so middleware helpers don't have to import Hono types directly. Each handler casts
/// once at the top.
ponder.get("/season", async (c) => {
  const mw = c as unknown as MwContext;
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const bypass = shouldBypassCache(mw);
  const r = await cached(
    seasonResponseCache,
    SEASON_CACHE_KEY,
    async () => getSeasonHandler(buildQueries(c.db)),
    {bypass},
  );
  mw.header("X-Cache", r.status);
  return c.json(r.value.body, r.value.status as 200 | 404);
});

ponder.get("/tokens", async (c) => {
  const mw = c as unknown as MwContext;
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const bypass = shouldBypassCache(mw);
  const r = await cached(
    tokensResponseCache,
    TOKENS_CACHE_KEY,
    async () => {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      return getTokensHandler(buildQueries(c.db), nowSec);
    },
    {bypass},
  );
  mw.header("X-Cache", r.status);
  return c.json(r.value.body, r.value.status as 200);
});

ponder.get("/token/:address", async (c) => {
  const mw = c as unknown as MwContext;
  // /token/:address isn't cached — single-token detail is small + the cardinality of
  // possible addresses is too high for a useful hit rate. Still rate-limited, though.
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const result = await getTokenDetailHandler(buildQueries(c.db), c.req.param("address") ?? "");
  return c.json(result.body, result.status as 200 | 400 | 404);
});

ponder.get("/profile/:address", async (c) => {
  const mw = c as unknown as MwContext;
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const raw = c.req.param("address") ?? "";
  // Validate before computing the cache key so invalid addresses can't pollute cache
  // entries / get parked under a 400-shaped value.
  const normalized = raw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    return c.json({error: "invalid address"}, 400);
  }
  const bypass = shouldBypassCache(mw);
  const r = await cached(
    profileResponseCache,
    profileCacheKey(normalized as `0x${string}`),
    async () => getProfileHandler(buildProfileQueries(c.db), normalized, () => new Date()),
    {bypass},
  );
  mw.header("X-Cache", r.status);
  return c.json(r.value.body as ProfileResponse | {error: string}, r.value.status as 200);
});

/// Adapts the Ponder `c.db` Drizzle handle into the database-agnostic `ApiQueries`
/// interface that pure handlers consume. The handlers don't care which schema columns or
/// where-clauses we use — they just take rows in and JSON out — so this mapping is the
/// only place that knows about Drizzle / Ponder.
function buildQueries(db: ApiDb): ApiQueries {
  return {
    latestSeason: async () => {
      const rows = await db.select().from(season).orderBy(desc(season.id)).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        startedAt: row.startedAt,
        phase: row.phase,
        totalPot: row.totalPot,
        bonusReserve: row.bonusReserve,
      };
    },
    publicLaunchCount: async (seasonId) => {
      const rows = await db
        .select({n: count()})
        .from(token)
        .where(and(eq(token.seasonId, seasonId), eq(token.isProtocolLaunched, false)));
      return Number(rows[0]?.n ?? 0);
    },
    tokensInSeason: async (seasonId) => {
      const rows = await db.select().from(token).where(eq(token.seasonId, seasonId));
      return rows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        isFinalist: r.isFinalist,
        liquidated: r.liquidated,
        liquidationProceeds: r.liquidationProceeds,
      }));
    },
    tokenByAddress: async (addr) => {
      const rows = await db.select().from(token).where(eq(token.id, addr)).limit(1);
      const row = rows[0];
      if (!row) return null;
      const detail: TokenDetailRow = {
        id: row.id,
        symbol: row.symbol,
        isFinalist: row.isFinalist,
        liquidated: row.liquidated,
        liquidationProceeds: row.liquidationProceeds,
        name: row.name,
        seasonId: row.seasonId,
        isProtocolLaunched: row.isProtocolLaunched,
      };
      return detail;
    },
  };
}

/// Profile-specific queries. Builds two indexes per request: tokens-by-creator and
/// claim-sums-by-user. Both go through the season table to resolve `WEEKLY_WINNER` status
/// per createdToken. There's no rank precomputation surfaced here — the ranks for the
/// current cohort are sourced from `tokensInSeason` + scoring on demand; for past seasons
/// we don't have a stored rank, so the wire shape ships rank=0 (handled in profile.ts).
function buildProfileQueries(db: ApiDb): ProfileQueries {
  return {
    createdTokensByCreator: async (creator) => {
      const tokenRows = await db
        .select()
        .from(token)
        .where(eq(token.creator, creator));
      if (tokenRows.length === 0) return [];
      // Resolve `season.winner` per distinct seasonId in one round-trip.
      const seasonIds = [...new Set(tokenRows.map((r) => r.seasonId))];
      const seasonRows = await Promise.all(
        seasonIds.map((id) => db.select().from(season).where(eq(season.id, id)).limit(1)),
      );
      const winnerBySeason = new Map<bigint, `0x${string}` | null>();
      for (const rows of seasonRows) {
        const s = rows[0];
        if (s) winnerBySeason.set(s.id, s.winner ?? null);
      }
      const out: CreatedTokenRow[] = tokenRows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        seasonId: r.seasonId,
        liquidated: r.liquidated,
        isFinalist: r.isFinalist,
        createdAt: r.createdAt,
        seasonWinner: winnerBySeason.get(r.seasonId) ?? null,
        rank: null,
      }));
      return out;
    },
    claimSumsForUser: async (user): Promise<ClaimSums> => {
      const [rolloverRows, bonusRows] = await Promise.all([
        db.select().from(rolloverClaim).where(eq(rolloverClaim.user, user)),
        db.select().from(bonusClaim).where(eq(bonusClaim.user, user)),
      ]);
      let rolloverEarnedWei = 0n;
      for (const r of rolloverRows) rolloverEarnedWei += r.winnerTokens;
      let bonusEarnedWei = 0n;
      for (const r of bonusRows) bonusEarnedWei += r.amount;
      return {rolloverEarnedWei, bonusEarnedWei};
    },
  };
}

/// Local alias for Ponder's API context db handle.
type ApiDb = ApiContext["db"];
