/// HTTP API routes — Epic 1.3 (parts 1+2+3/3) + indexer-enrichment (PR #45).
///
/// Mounts on Ponder's built-in Hono server (default port 42069) via `ponder.get`. Endpoints:
///
///   GET /season                          — current season state, cadence anchors, prize pools
///   GET /tokens                          — ranked cohort with HP + components + status + bag-lock
///   GET /token/:address                  — minimal per-token detail (used by leaderboard)
///   GET /tokens/:address/history         — HP timeseries for one token (admin drilldown)
///   GET /profile/:address                — wallet stats: tokens + claims + swap volume + badges
///
/// Deliberately NOT exposed in genesis (Phase 1 audit 2026-05-01, finding C-4):
///   GET /tokens/:address/holders         — deferred to Phase 2. The underlying
///                                          `holderBalance` + `holderSnapshot` tables are
///                                          populated; the HTTP surface waits on the
///                                          §41.3 concentration filter to drive shape
///                                          decisions (pagination, dust cutoff, bag-locked
///                                          creator handling). See README §"Known gaps"
///                                          + §"Outstanding" for the full rationale.
///
/// Liveness (`/health`), readiness (`/ready`), and metrics (`/metrics`) are served by
/// Ponder itself — they're reserved paths and adding our own here would fail validation.
/// `/health` returns 200 as soon as the HTTP server is up (independent of indexer sync),
/// which is what Railway's healthcheck targets via `railway.json`.
///
/// Cross-cutting concerns wired in here:
///   - **Per-IP rate limit** — token bucket on every GET; `/events` is governed separately
///     by a connection cap (see `events/index.ts`).
///   - **Read-through cache** — `/season`, `/tokens`, `/profile`, `/tokens/:address/history`
///     are wrapped in an LRU+TTL cache. `X-Cache: HIT|MISS|BYPASS` reflects which branch
///     served the request.
///   - **Headers** — `RateLimit-Remaining` on every response, `Retry-After` on 429.
///
/// Route handlers stay thin: they translate Drizzle queries into the small `ApiQueries`
/// / `ProfileQueries` / `HistoryQueries` shapes that pure handlers consume. The middleware
/// module owns the shared rate-limit + cache singletons so the SSE route shares the same
/// per-IP budget.

import {ponder, type ApiContext} from "@/generated";
import {and, count, desc, eq, gte, inArray, lte} from "@ponder/core";
import {cors} from "hono/cors";

import {
  bonusClaim,
  creatorLock,
  holderSnapshot,
  hpSnapshot,
  rolloverClaim,
  season,
  swap,
  token,
  tournamentAnnualEntrant,
  tournamentQuarterEntrant,
  tournamentStatus,
} from "../../ponder.schema";

import {isAddressLike} from "./builders.js";
import {cached} from "./cache.js";
import {loadCorsConfigFromEnv, originAllowed} from "./cors.js";
import {toMwContext} from "./mwContext.js";
import {checkAndLogCadence, consoleCadenceLogger} from "./snapshotCadence.js";
import {
  getReadinessHandler,
  getSeasonHandler,
  getTokenDetailHandler,
  getTokensHandler,
  type ApiQueries,
  type BagLockRow,
  type TokenDetailRow,
} from "./handlers.js";
import {eventsEngineRunning} from "./events/index.js";
import {getTokenHistoryHandler, type HistoryQueries, type HpSnapshotRow} from "./history.js";
import {
  applyGetRateLimit,
  historyCacheKey,
  historyResponseCache,
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
  type CreatedTokenStatus,
  type HolderBadgeFlags,
  type ProfileQueries,
  type ProfileResponse,
  type SwapAggregates,
  type TournamentBadgeFlags,
} from "./profile.js";

/// Audit H-6 (Phase 1, 2026-05-01): CORS middleware. Origin allow-list is loaded from
/// env at module-import time via `CORS_ALLOWED_ORIGINS` (comma-separated); falls back
/// to the default list (filter.fun + docs subdomain + localhost dev ports) when unset.
/// Mounted via `ponder.use("*", ...)` so every route + the SSE endpoint share the
/// same policy. `originAllowed` returns the matched origin (not `*`) so cached
/// responses stay scoped to the specific allowed origin that requested them.
const corsCfg = loadCorsConfigFromEnv();
ponder.use(
  "*",
  cors({
    origin: (origin) => originAllowed(origin, corsCfg),
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 600,
  }),
);

ponder.get("/season", async (c) => {
  const mw = toMwContext(c);
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
  // Audit H-2: /season always returns 200 (envelope discriminates ready vs not-ready).
  return c.json(r.value.body, r.value.status as 200);
});

ponder.get("/tokens", async (c) => {
  const mw = toMwContext(c);
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
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const result = await getTokenDetailHandler(buildQueries(c.db), c.req.param("address") ?? "");
  return c.json(result.body, result.status as 200 | 400 | 404);
});

ponder.get("/tokens/:address/history", async (c) => {
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const raw = c.req.param("address") ?? "";
  const normalized = raw.toLowerCase();
  if (!isAddressLike(normalized)) {
    return c.json({error: "invalid address"}, 400);
  }
  const url = new URL(mw.req.url);
  const params = {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    interval: url.searchParams.get("interval") ?? undefined,
  };
  const bypass = shouldBypassCache(mw);
  const cacheKey = historyCacheKey(normalized as `0x${string}`, params);
  const r = await cached(
    historyResponseCache,
    cacheKey,
    async () =>
      getTokenHistoryHandler(buildHistoryQueries(c.db), normalized, params, {
        nowSec: BigInt(Math.floor(Date.now() / 1000)),
      }),
    {bypass},
  );
  mw.header("X-Cache", r.status);
  return c.json(r.value.body, r.value.status as 200 | 400);
});

/// Audit H-4 (Phase 1, 2026-05-01) — readiness probe distinct from Ponder's /health.
/// /health (reserved by Ponder) returns 200 as soon as the HTTP server is up — useful
/// for liveness checks but blind to indexer sync state. /readiness returns 200 only
/// when the indexer has at least one season indexed AND the live-event pipeline is
/// running, 503 otherwise. Wire to deployer readiness probe (separate from liveness).
ponder.get("/readiness", async (c) => {
  // No rate limit on readiness — probes hit it at infrastructure cadence (every few
  // seconds from the load balancer) and rate-limiting them would make a healthy
  // indexer look unhealthy under normal probe pressure.
  //
  // Bugbot finding on PR #61: this handler intentionally skips `toMwContext(c)`. Every
  // other route validates Context shape via the adapter (audit H-3) but readiness must
  // not — a shape-drift throw here would surface as a 500 on the load-balancer probe,
  // making a healthy indexer look broken until the LB deregistered the instance.
  // Probes need to read `c.db` (for the season query) and `c.json` only; both are
  // direct-property accesses with no middleware-style assumptions, so the adapter's
  // assertions are pure downside on this endpoint.
  const r = await getReadinessHandler({
    latestSeasonId: async () => {
      const rows = await c.db.select().from(season).orderBy(desc(season.id)).limit(1);
      const row = rows[0];
      return row ? Number(row.id) : null;
    },
    tickEngineRunning: () => eventsEngineRunning(),
  });
  return c.json(r.body, r.status as 200 | 503);
});

ponder.get("/profile/:address", async (c) => {
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const raw = c.req.param("address") ?? "";
  // Validate before computing the cache key so invalid addresses can't pollute cache
  // entries / get parked under a 400-shaped value.
  const normalized = raw.toLowerCase();
  if (!isAddressLike(normalized)) {
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
/// interface that pure handlers consume.
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
        creator: r.creator,
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
        creator: row.creator,
        name: row.name,
        seasonId: row.seasonId,
        isProtocolLaunched: row.isProtocolLaunched,
      };
      return detail;
    },
    bagLocksForTokens: async (tokens) => {
      if (tokens.length === 0) return [];
      // Locks are keyed by `(creator, token)` not just token, so we read all rows
      // matching any of the supplied tokens. Genesis volume is small (12-launch cap
      // per active season + history of past tokens), so a single `inArray` query is
      // fine; if/when this gets hot, an index on `creator_lock.token` resolves it.
      const rows = await db
        .select()
        .from(creatorLock)
        .where(inArray(creatorLock.token, [...tokens]));
      const out: BagLockRow[] = rows.map((r) => ({
        token: r.token,
        creator: r.creator,
        unlockTimestamp: r.unlockTimestamp,
      }));
      return out;
    },
  };
}

function buildHistoryQueries(db: ApiDb): HistoryQueries {
  return {
    hpSnapshotsForToken: async (tokenAddr, fromSec, toSec) => {
      const rows = await db
        .select()
        .from(hpSnapshot)
        .where(
          and(
            eq(hpSnapshot.token, tokenAddr),
            gte(hpSnapshot.snapshotAtSec, fromSec),
            lte(hpSnapshot.snapshotAtSec, toSec),
          ),
        )
        .orderBy(hpSnapshot.snapshotAtSec);
      const out: HpSnapshotRow[] = rows.map((r) => ({
        token: r.token,
        snapshotAtSec: r.snapshotAtSec,
        hp: r.hp,
        rank: r.rank,
        velocity: r.velocity,
        effectiveBuyers: r.effectiveBuyers,
        stickyLiquidity: r.stickyLiquidity,
        retention: r.retention,
        momentum: r.momentum,
        phase: r.phase,
      }));
      return out;
    },
  };
}

/// Profile-specific queries. Builds several indexes per request: tokens-by-creator,
/// claim-sums-by-user, swap-aggregates-by-user, holder-flags-by-user, tournament-flags-by-user.
function buildProfileQueries(db: ApiDb): ProfileQueries {
  return {
    createdTokensByCreator: async (creator) => {
      const tokenRows = await db
        .select()
        .from(token)
        .where(eq(token.creator, creator));
      if (tokenRows.length === 0) return [];
      const seasonIds = [...new Set(tokenRows.map((r) => r.seasonId))];
      const seasonRows = await Promise.all(
        seasonIds.map((id) => db.select().from(season).where(eq(season.id, id)).limit(1)),
      );
      const winnerBySeason = new Map<bigint, `0x${string}` | null>();
      for (const rows of seasonRows) {
        const s = rows[0];
        if (s) winnerBySeason.set(s.id, s.winner ?? null);
      }
      // Tournament status: one bulk query against `tournament_status` for the whole
      // creator-token set.
      const tokenAddrs = tokenRows.map((r) => r.id);
      const statusRows = await db
        .select()
        .from(tournamentStatus)
        .where(inArray(tournamentStatus.id, tokenAddrs));
      const statusByToken = new Map<string, CreatedTokenStatus>();
      for (const sr of statusRows) {
        statusByToken.set(sr.id.toLowerCase(), sr.status as CreatedTokenStatus);
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
        tournamentStatus: statusByToken.get(r.id.toLowerCase()) ?? null,
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
    swapAggregatesForUser: async (user): Promise<SwapAggregates> => {
      const rows = await db.select().from(swap).where(eq(swap.taker, user));
      let lifetime = 0n;
      const tokens = new Set<string>();
      for (const r of rows) {
        lifetime += r.wethValue;
        tokens.add(r.token.toLowerCase());
      }
      return {lifetimeTradeVolumeWei: lifetime, tokensTraded: tokens.size};
    },
    holderBadgeFlagsForUser: async (user): Promise<HolderBadgeFlags> => {
      // Pull all snapshots whose `holder = user`. Then derive flags + filtersSurvived
      // from the trigger column. Two queries (CUT + FINALIZE union) would be marginally
      // less data shipped, but the `holder` index handles 10s of rows per wallet — one
      // query is simpler and cache-friendlier.
      const rows = await db
        .select()
        .from(holderSnapshot)
        .where(eq(holderSnapshot.holder, user));
      let weekWinner = false;
      let filterSurvivor = false;
      const cutSeasons = new Set<bigint>();
      // Resolve season-winner per `seasonId` so we can identify FINALIZE-trigger
      // snapshots that match the winner. (FINALIZE writes only the winner's holders,
      // so any FINALIZE row already implies the wallet held the winner — but the
      // schema permits future use for losers too, so we narrow defensively.)
      const seasonIds = [...new Set(rows.map((r) => r.seasonId))];
      const seasonRows = await Promise.all(
        seasonIds.map((id) => db.select().from(season).where(eq(season.id, id)).limit(1)),
      );
      const winnerBySeason = new Map<bigint, `0x${string}` | null>();
      // Audit H-5 (Phase 1, 2026-05-01): also capture season.startedAt so we can validate
      // each snapshot's actual on-chain timestamp against the spec §42 cadence anchors
      // (CUT @ hour 96, FINALIZE @ hour 168). Drift > 5 min logs a structured warning;
      // never fails the request.
      const seasonStartBySeason = new Map<bigint, bigint>();
      for (const ss of seasonRows) {
        const s = ss[0];
        if (s) {
          winnerBySeason.set(s.id, s.winner ?? null);
          seasonStartBySeason.set(s.id, s.startedAt);
        }
      }
      for (const r of rows) {
        // Audit H-5: validate cadence per snapshot. The check is fire-and-forget for
        // the request path; verdict.drifted is observed via the warn log line.
        const seasonStartedAt = seasonStartBySeason.get(r.seasonId);
        if (seasonStartedAt !== undefined) {
          checkAndLogCadence(
            {
              trigger: r.trigger,
              blockTimestamp: r.blockTimestamp,
              seasonStartedAt,
              seasonId: r.seasonId,
            },
            consoleCadenceLogger,
          );
        }
        if (r.trigger === "FINALIZE") {
          const winner = winnerBySeason.get(r.seasonId);
          if (winner && winner.toLowerCase() === r.token.toLowerCase()) {
            weekWinner = true;
          }
        } else if (r.trigger === "CUT") {
          filterSurvivor = true;
          cutSeasons.add(r.seasonId);
        }
      }
      return {weekWinner, filterSurvivor, filtersSurvived: cutSeasons.size};
    },
    tournamentBadgeFlagsForUser: async (user): Promise<TournamentBadgeFlags> => {
      // Tournament badges are earned by holding a token that ever competed in the
      // corresponding tier. Join `holder_snapshot[holder=user]` × tournament-entrant
      // memberships. We avoid materializing the join in SQL — a tiny per-wallet set
      // shipped to JS hash-joins faster than crafting a custom Drizzle CTE here, and
      // keeps the queries module compatible with the test fixture pattern.
      const snapshotRows = await db
        .select()
        .from(holderSnapshot)
        .where(eq(holderSnapshot.holder, user));
      if (snapshotRows.length === 0) {
        return {
          quarterlyFinalist: false,
          quarterlyChampion: false,
          annualFinalist: false,
          annualChampion: false,
        };
      }
      const heldTokens = [...new Set(snapshotRows.map((r) => r.token.toLowerCase()))] as `0x${string}`[];
      const [qRows, aRows] = await Promise.all([
        db.select().from(tournamentQuarterEntrant).where(inArray(tournamentQuarterEntrant.token, heldTokens)),
        db.select().from(tournamentAnnualEntrant).where(inArray(tournamentAnnualEntrant.token, heldTokens)),
      ]);
      let quarterlyFinalist = false;
      let quarterlyChampion = false;
      for (const q of qRows) {
        quarterlyFinalist = true;
        if (q.isChampion) quarterlyChampion = true;
      }
      let annualFinalist = false;
      let annualChampion = false;
      for (const a of aRows) {
        annualFinalist = true;
        if (a.isChampion) annualChampion = true;
      }
      return {quarterlyFinalist, quarterlyChampion, annualFinalist, annualChampion};
    },
  };
}

/// Local alias for Ponder's API context db handle.
type ApiDb = ApiContext["db"];
