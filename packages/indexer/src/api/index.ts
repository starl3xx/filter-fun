/// HTTP API routes — Epic 1.3 (parts 1+2+3/3) + indexer-enrichment (PR #45).
///
/// Mounts on Ponder's built-in Hono server (default port 42069) via `ponder.get`. Endpoints:
///
///   GET /season                                — current season state, cadence anchors, prize pools
///   GET /tokens                                — ranked cohort with HP + components + status + bag-lock
///   GET /token/:address                        — minimal per-token detail (used by leaderboard)
///   GET /tokens/:address/history               — HP timeseries for one token (admin drilldown)
///   GET /tokens/:address/component-deltas      — per-component swap-impact rows (Epic 1.23)
///   GET /profile/:address                      — wallet stats: tokens + claims + swap volume + badges
///                                                Accepts `?role=creator` (Epic 1.23) to narrow to the creator-keyed surface.
///   GET /wallets/:address/holdings             — per-wallet positions + projected rollover (Epic 1.23)
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
import {and, count, desc, eq, gte, inArray, lte, max} from "@ponder/core";
import {cors} from "hono/cors";

import {
  bonusClaim,
  creatorEarning,
  creatorLock,
  feeAccrual,
  holderBalance,
  holderSnapshot,
  hpSnapshot,
  launchEscrowSummary,
  liquidation,
  pendingRefund,
  phaseChange,
  reservation,
  rolloverClaim,
  season,
  seasonTickerReservation,
  swap,
  tickerBlocklist,
  token,
  tournamentAnnualEntrant,
  tournamentQuarterEntrant,
  tournamentStatus,
  winnerTickerReservation,
} from "../../ponder.schema";

import {isAddressLike, type SeasonMargins, type SeasonRow} from "./builders.js";
import {cached} from "./cache.js";
import {loadCorsConfigFromEnv, originAllowed} from "./cors.js";
import {toMwContext} from "./mwContext.js";
import {checkAndLogCadence, consoleCadenceLogger} from "./snapshotCadence.js";
import {
  getCreatorEarningsHandler,
  getReadinessHandler,
  getSeasonByIdHandler,
  getSeasonHandler,
  getTokenDetailHandler,
  getTokensHandler,
  type ApiQueries,
  type BagLockRow,
  type CreatorEarningRow,
  type TokenDetailRow,
} from "./handlers.js";
import {
  getGraveyardDetailHandler,
  getGraveyardHandler,
  type GraveyardDetailQueries,
  type GraveyardQueries,
} from "./graveyard.js";
import {
  getWinnerMetricsHandler,
  getWinnersHandler,
  type WinnerMetricsQueries,
  type WinnersQueries,
} from "./winners.js";
import {fetchProjectionInputsFromDb} from "./hp.js";
import {ensureEventsEngineStarted, eventsEngineRunning} from "./events/index.js";
import {buildScoringWeightsResponse} from "./scoringWeights.js";
import {getTokenHistoryHandler, type HistoryQueries, type HpSnapshotRow} from "./history.js";
import {
  applyHttpRateLimit,
  historyCacheKey,
  historyResponseCache,
  holdingsCacheKey,
  holdingsResponseCache,
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
  type ProfileRoleFilter,
  type SwapAggregates,
  type TournamentBadgeFlags,
} from "./profile.js";
import {
  getHoldingsHandler,
  type CutSnapshotForToken,
  type HoldingsQueries,
  type HoldingsResponse,
  type HoldingTokenRow,
} from "./holdings.js";
import {
  getComponentDeltasHandler,
  type ComponentDeltasQueries,
  type ComponentDeltasResponse,
  type SnapshotRow,
  type SwapJoinRow,
} from "./componentDeltas.js";
import {
  checkUsernameAvailability,
  resolveProfileIdentifier,
  setUsernameHandler,
  userProfileBlockFromRow,
} from "./userProfileHandler.js";
import {
  createPgUserProfileStore,
  type UserProfileStore,
} from "./userProfileStore.js";

/// Audit H-6 (Phase 1, 2026-05-01): CORS middleware. Origin allow-list is loaded from
/// env at module-import time via `CORS_ALLOWED_ORIGINS` (comma-separated); falls back
/// to the default list (filter.fun + docs subdomain + localhost dev ports) when unset.
/// Mounted via `ponder.use("*", ...)` so every route + the SSE endpoint share the
/// same policy. `originAllowed` returns the matched origin (not `*`) so cached
/// responses stay scoped to the specific allowed origin that requested them.
///
/// Bugbot finding #3 on PR #61 (Medium): `exposeHeaders` MUST list every custom
/// response header the middleware sets. Per the Fetch spec, only CORS-safelisted
/// response headers (Cache-Control, Content-Language, Content-Length, Content-Type,
/// Expires, Last-Modified, Pragma) are visible to browser JS by default — `RateLimit-
/// Remaining`/`Retry-After`/`X-Cache` would be silently stripped from the cross-origin
/// response, breaking the rate-limit feedback loop and the cache-status header for
/// browser clients on filter.fun. SSE-side `Last-Event-ID` is safelisted; nothing else
/// the indexer emits needs explicit exposure today, but extend this list whenever a
/// new custom header lands.
const corsCfg = loadCorsConfigFromEnv();
ponder.use(
  "*",
  cors({
    origin: (origin) => originAllowed(origin, corsCfg),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    exposeHeaders: ["RateLimit-Remaining", "Retry-After", "X-Cache"],
    maxAge: 600,
  }),
);

/// Epic 1.24 — off-chain `userProfile` store.
///
/// Bootstrapped lazily on first request because:
///   - Ponder's API server may start before `DATABASE_URL` is honored by the
///     indexer process (PGlite fallback in dev with no env var); we want to
///     avoid a hard `pg.Pool` instantiation at module-load time when the
///     env may not yet point at a real Postgres.
///   - Tests import this module without a DATABASE_URL and shouldn't pay
///     for a connection attempt that's irrelevant to the route under test.
///
/// In production (Railway), `DATABASE_URL` is set; the first
/// `getUserProfileStore()` call constructs a `pg.Pool` and runs the idempotent
/// `CREATE TABLE IF NOT EXISTS` migration. In dev without `DATABASE_URL`,
/// `getUserProfileStore()` throws on first call — POST/availability routes
/// surface a 503 ("identity layer unavailable"), GET /profile/:identifier
/// degrades to address-only (the username path is unreachable, but address
/// lookups continue to work as before via the existing handler).
/// Bugbot L PR #102: cache the in-flight `Promise`, not the resolved store,
/// so two concurrent first requests share the same boot work. Pre-fix, the
/// guard was `if (singleton !== null) return singleton` — both racers see
/// `null`, both `import("pg")`, both `new Pool()`, both `ensureSchema()`,
/// and the second-to-resolve overwrites the singleton. The first pool (up
/// to 4 connections) leaks for the lifetime of the process. Caching the
/// promise turns the second caller into an `await` of the first.
let userProfileStorePromise: Promise<UserProfileStore> | null = null;

async function getUserProfileStore(): Promise<UserProfileStore> {
  if (userProfileStorePromise !== null) return userProfileStorePromise;
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Don't cache the failure — env can be set after process boot in some
    // dev workflows (loaded later by a wrapper). Each call will re-check
    // until DATABASE_URL appears, then transition to the cached-promise
    // path. The error itself is identity-stable so callers branching on
    // it produce stable HTTP responses.
    throw new Error(
      "userProfile store requires DATABASE_URL — identity layer unavailable",
    );
  }
  userProfileStorePromise = (async () => {
    // Dynamic import avoids loading `pg` until a route actually needs it.
    // We don't carry @types/pg — cast through `unknown` to the minimal shape
    // `userProfileStore.ts` consumes (a `Pool.query` method).
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- no @types/pg installed; runtime types verified at boundary.
    const pgModule = await import("pg");
    const PoolCtor = (pgModule as {Pool: new (cfg: unknown) => unknown}).Pool;
    const pool = new PoolCtor({connectionString: url, max: 4});
    const store = createPgUserProfileStore(pool as import("./userProfileStore.js").Pool);
    await store.ensureSchema();
    return store;
  })().catch((err) => {
    // A construction failure (e.g. ensureSchema rejection on a malformed
    // DATABASE_URL) MUST clear the cached promise — otherwise every future
    // request resolves a permanently-rejected promise even after the
    // operator fixes the env. Setting back to null lets the next call
    // attempt boot fresh.
    userProfileStorePromise = null;
    throw err;
  });
  return userProfileStorePromise;
}

ponder.get("/season", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
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

/// Epic 1.25/1.26/1.27 — `GET /season/:id` (specific season).
///
/// Returns the same envelope as `/season` but addressed by id. Unlike the
/// `/season/:id/launch-status` and `/season/:id/tickers/check` siblings, this
/// endpoint returns the full `SeasonResponse` body — including the new margin
/// fields (`cutLineHp` / `winningHp` / `secondPlaceHp` / `winMarginHp`) used by
/// the graveyard's near-miss math + the winner detail page's squeaker callout.
/// Param shape collision with `/season/:id/...` routes is impossible (the more-
/// specific routes register paths with extra segments and Ponder/Hono routes
/// longest-prefix first).
ponder.get("/season/:id", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const queries = buildQueries(c.db);
  const seasonById = buildSeasonByIdLookup(c.db);
  const r = await getSeasonByIdHandler({...queries, seasonById}, c.req.param("id") ?? "");
  return c.json(r.body as object, r.status as 200 | 400);
});

/// Epic 1.25 — graveyard archive index.
///
/// Aggregate index of every filtered token across every indexed season. Powers
/// the `/graveyard` web page. Pagination + filter + sort are query-driven.
ponder.get("/graveyard", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const url = new URL(mw.req.url);
  const params = {
    season: url.searchParams.get("season") ?? undefined,
    creator: url.searchParams.get("creator") ?? undefined,
    ticker: url.searchParams.get("ticker") ?? undefined,
    nearMiss: url.searchParams.get("nearMiss") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    perPage: url.searchParams.get("perPage") ?? undefined,
  };
  const r = await getGraveyardHandler(buildGraveyardQueries(c.db), params, () =>
    Math.floor(Date.now() / 1000),
  );
  return c.json(r.body, r.status as 200 | 400);
});

/// Epic 1.25 — per-token historical (graveyard detail).
ponder.get("/graveyard/:address", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const r = await getGraveyardDetailHandler(
    buildGraveyardDetailQueries(c.db),
    c.req.param("address") ?? "",
  );
  return c.json(r.body, r.status as 200 | 400 | 404);
});

/// Epic 1.26 — list of all season winners.
ponder.get("/winners", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const r = await getWinnersHandler(buildWinnersQueries(c.db));
  return c.json(r.body, r.status as 200);
});

/// Epic 1.26 — long-tail metrics for a single winner.
ponder.get("/winners/:address/metrics", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const r = await getWinnerMetricsHandler(
    buildWinnerMetricsQueries(c.db),
    c.req.param("address") ?? "",
  );
  return c.json(r.body, r.status as 200 | 400 | 404);
});

ponder.get("/tokens", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
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
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const result = await getTokenDetailHandler(buildQueries(c.db), c.req.param("address") ?? "");
  return c.json(result.body, result.status as 200 | 400 | 404);
});

/// Epic 1.16 (spec §10.3 + §10.6): per-token creator-fee surface. Powers the creator
/// admin console "claim past tokens" flow + the cost/ROI calculator's winner long-tail
/// projection. Returns a zero-shaped payload for tokens that haven't accrued yet so the
/// UI's still-earning badge can render against any token without special-casing absence.
ponder.get("/tokens/:address/creator-earnings", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const result = await getCreatorEarningsHandler(buildQueries(c.db), c.req.param("address") ?? "");
  return c.json(result.body, result.status as 200 | 400 | 404);
});

ponder.get("/tokens/:address/history", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
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
  // Bugbot finding #1 on PR #61: this handler intentionally skips `toMwContext(c)`.
  // Every other route validates Context shape via the adapter (audit H-3) but readiness
  // must not — a shape-drift throw here would surface as a 500 on the load-balancer
  // probe, making a healthy indexer look broken until the LB deregistered the instance.
  // Probes need to read `c.db` (for the season query) and `c.json` only; both are
  // direct-property accesses with no middleware-style assumptions, so the adapter's
  // assertions are pure downside on this endpoint.
  //
  // Bugbot finding #2 on PR #61 (Medium): bootstrap the events engine here. The engine
  // is started lazily on the first SSE request, but if a load balancer gates traffic
  // on /readiness (the documented use case) and the engine is part of the readiness
  // verdict, no SSE request ever reaches the indexer → engine never starts →
  // readiness permanently 503 → indexer permanently unreachable. Calling
  // `ensureEventsEngineStarted(c.db)` on every probe is idempotent (the inner check
  // no-ops once the engine exists) and breaks the deadlock: the first probe boots the
  // engine, all subsequent probes confirm it stays running.
  ensureEventsEngineStarted(c.db);
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

/// Epic 1.17a (2026-05-03 v4 lock) — public transparency endpoint exposing
/// the active HP weight set + feature-flag state. Reads from the scoring
/// package's locked constants and `process.env`; no DB access. Rate-limited
/// in line with other public GETs. CORS coverage flows through the global
/// middleware (PR #61).
ponder.get("/scoring/weights", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  return c.json(buildScoringWeightsResponse(process.env), 200);
});

/// Epic 1.15a — pre-flight ticker availability check for the launch form.
///
/// Off-chain reproduction of the contract's `reserve` validation cascade:
///   1. `normalizeTicker(t)` rejects format errors (length, punctuation, non-ASCII)
///   2. `tickerBlocklist[hash]`              → `blocklisted`
///   3. `winnerTickers[hash]`                → `winner_taken`
///   4. `seasonTickers[seasonId][hash]`      → `season_taken`
///   5. otherwise                            → `available`
///
/// The `:id` path param is the SEASON id (a uint), not a token address.
/// Query: `?ticker=PEPE` (or `?t=PEPE`). The handler accepts either name to
/// match the launch form's URL builder.
///
/// Response shape:
///   200 { ok: "available", canonical: "PEPE", hash: "0x..." }
///   200 { ok: "blocklisted", canonical: "FILTER", hash: "0x..." }
///   200 { ok: "winner_taken", canonical: "PEPEWIN", hash: "0x...", reservedSeasonId: "1" }
///   200 { ok: "season_taken", canonical: "PEPE", hash: "0x...", reservedBy: "0x..." }
///   400 { error: "invalid format", raw: "PE-PE" }
///   400 { error: "missing ticker" }
///
/// Always 200 on a known-status answer (including blocked/taken) so a UI doesn't
/// have to distinguish between "ticker is bad" and "request was bad" — caller
/// branches on the body's `ok` enum. 400 is reserved for malformed REQUESTS.
ponder.get("/season/:id/tickers/check", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;

  const seasonIdRaw = c.req.param("id") ?? "";
  let seasonId: bigint;
  try {
    seasonId = BigInt(seasonIdRaw);
    if (seasonId < 0n) throw new Error("negative");
  } catch {
    return c.json({error: "invalid season id", raw: seasonIdRaw}, 400);
  }

  const url = new URL(mw.req.url);
  const rawTicker = url.searchParams.get("ticker") ?? url.searchParams.get("t") ?? "";
  if (rawTicker.length === 0) return c.json({error: "missing ticker"}, 400);

  // Lazy-import to keep the tickerlib's keccak/toBytes off the API module's hot path
  // when /season/:id/tickers/check isn't being hit.
  //
  // Audit: bugbot L PR #92. Hash directly from the canonical form returned by
  // `tryNormalizeTicker` rather than calling `hashTicker(rawTicker)` (which would
  // re-run the entire normalize pipeline). Single byte-level scan.
  const [{tryNormalizeTicker}, {keccak256, toBytes}] = await Promise.all([
    import("./ticker.js"),
    import("viem"),
  ]);
  const norm = tryNormalizeTicker(rawTicker);
  if (!norm.ok) {
    return c.json({error: "invalid format", raw: rawTicker}, 400);
  }
  const canonical = norm.canonical;
  const hash = keccak256(toBytes(canonical));

  // 1. Protocol blocklist — same hash space as winnerTickers (single bytes32 key per
  //    contract). The `tickerBlocklist` row is canonical because it was written by
  //    the indexer from a `TickerBlocked` event; the multisig's off-chain pipeline
  //    is responsible for ensuring the hash they passed in IS canonical (see the
  //    `addTickerToBlocklist` consumer-contract NatSpec).
  const blocked = await c.db
    .select()
    .from(tickerBlocklist)
    .where(eq(tickerBlocklist.id, hash))
    .limit(1);
  if (blocked[0]) {
    return c.json({ok: "blocklisted", canonical, hash}, 200);
  }

  // 2. Cross-season winner reservation.
  const winner = await c.db
    .select()
    .from(winnerTickerReservation)
    .where(eq(winnerTickerReservation.id, hash))
    .limit(1);
  if (winner[0]) {
    return c.json(
      {
        ok: "winner_taken",
        canonical,
        hash,
        reservedSeasonId: winner[0].seasonId.toString(),
      },
      200,
    );
  }

  // 3. Per-season reservation.
  const reservedRow = await c.db
    .select()
    .from(seasonTickerReservation)
    .where(eq(seasonTickerReservation.id, `${seasonId.toString()}:${hash}`))
    .limit(1);
  if (reservedRow[0]) {
    return c.json(
      {ok: "season_taken", canonical, hash, reservedBy: reservedRow[0].creator},
      200,
    );
  }

  return c.json({ok: "available", canonical, hash}, 200);
});

/// Epic 1.15a — per-season escrow + reservation rollup for the Arena UI's
/// "Reservation lifecycle" surface. Reads `launchEscrowSummary` for aggregates
/// and joins `reservation` for the slot grid; `pendingRefund` for any wallet's
/// claim CTAs is fetched via the wallet-scoped `/profile/:address` (already
/// shipped in Epic 1.3) — this endpoint is season-scoped and excludes per-wallet
/// PII (no creator addresses on summary, just counts).
///
/// Response shape:
///   200 {
///     seasonId: "1",
///     activated: false,
///     aborted: false,
///     activatedAt: null,
///     abortedAt: null,
///     reservationCount: 3,
///     totalEscrowedWei: "150000000000000000",
///     totalReleasedWei: "0",
///     totalRefundedWei: "0",
///     totalRefundPendingWei: "0",
///     totalForfeitedWei: "0",
///     reservations: [
///       { creator: "0x...", slotIndex: "0", tickerHash: "0x...", status: "PENDING",
///         escrowAmountWei: "50000000000000000", reservedAt: "1715000000",
///         resolvedAt: null, token: null }
///     ]
///   }
///   404 if no `launchEscrowSummary` row exists for the season (i.e. season hasn't
///   been started, or the indexer hasn't ingested the SeasonStarted yet).
ponder.get("/season/:id/launch-status", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;

  const seasonIdRaw = c.req.param("id") ?? "";
  let seasonId: bigint;
  try {
    seasonId = BigInt(seasonIdRaw);
    if (seasonId < 0n) throw new Error("negative");
  } catch {
    return c.json({error: "invalid season id", raw: seasonIdRaw}, 400);
  }

  const summaryRow = await c.db
    .select()
    .from(launchEscrowSummary)
    .where(eq(launchEscrowSummary.id, seasonId))
    .limit(1);
  const summary = summaryRow[0];
  if (!summary) return c.json({error: "season not found"}, 404);

  const reservations = await c.db
    .select()
    .from(reservation)
    .where(eq(reservation.seasonId, seasonId))
    .orderBy(reservation.slotIndex);

  return c.json(
    {
      seasonId: seasonId.toString(),
      activated: summary.activated,
      aborted: summary.aborted,
      activatedAt: summary.activatedAt !== null ? summary.activatedAt.toString() : null,
      abortedAt: summary.abortedAt !== null ? summary.abortedAt.toString() : null,
      reservationCount: summary.reservationCount,
      totalEscrowedWei: summary.totalEscrowed.toString(),
      totalReleasedWei: summary.totalReleased.toString(),
      totalRefundedWei: summary.totalRefunded.toString(),
      totalRefundPendingWei: summary.totalRefundPending.toString(),
      totalForfeitedWei: summary.totalForfeited.toString(),
      reservations: reservations.map((r) => ({
        creator: r.creator,
        slotIndex: r.slotIndex.toString(),
        tickerHash: r.tickerHash,
        metadataHash: r.metadataHash,
        status: r.status,
        escrowAmountWei: r.escrowAmount.toString(),
        reservedAt: r.reservedAt.toString(),
        resolvedAt: r.resolvedAt !== null ? r.resolvedAt.toString() : null,
        token: r.token,
      })),
    },
    200,
  );
});

/// Epic 1.15a — per-wallet pending refund query. Used by the Arena's "you have
/// X ETH waiting" banner. Returns ALL unclaimed `pendingRefund` rows for a wallet
/// across every season (creators may have failed pushes from multiple aborted
/// seasons piled up).
ponder.get("/wallet/:address/pending-refunds", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;

  const raw = c.req.param("address") ?? "";
  const normalized = raw.toLowerCase();
  if (!isAddressLike(normalized)) {
    return c.json({error: "invalid address"}, 400);
  }

  const rows = await c.db
    .select()
    .from(pendingRefund)
    .where(and(eq(pendingRefund.creator, normalized as `0x${string}`), eq(pendingRefund.claimed, false)))
    .orderBy(pendingRefund.failedAt);

  return c.json(
    {
      wallet: normalized,
      pending: rows.map((r) => ({
        seasonId: r.seasonId.toString(),
        amountWei: r.amount.toString(),
        failedAt: r.failedAt.toString(),
      })),
    },
    200,
  );
});

/// Epic 1.24 — username availability check. Strictly informational; the
/// POST endpoint re-runs every check at write time, so a slow client can hold
/// an "available" verdict that's stale by the time the user submits. Cheap
/// enough to skip the response cache (no DB-shape derivation, just a couple
/// of indexed lookups).
ponder.get("/profile/username/:username/available", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const raw = c.req.param("username") ?? "";
  let store: UserProfileStore;
  try {
    store = await getUserProfileStore();
  } catch {
    return c.json({error: "identity layer unavailable"}, 503);
  }
  const r = await checkUsernameAvailability(store, raw);
  return c.json(r, 200);
});

/// Epic 1.24 — `POST /profile/:address/username`.
///
/// Signed-message authentication. The signed payload format is owned by
/// `buildSetUsernameMessage`; the wallet client constructs the same string
/// and `personal_sign`s it. Recovery happens server-side via viem; the path
/// address is the authoritative `actor` (we don't trust a "from" field in
/// the body — the only way to set X's username is to sign as X).
///
/// Bugbot follow-up reservation: this is the load-bearing security boundary
/// of the identity layer. Any change to the message format MUST be backed by
/// a wallet-client release, since deployed signers will continue to produce
/// the old format until upgraded.
ponder.post("/profile/:address/username", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  let store: UserProfileStore;
  try {
    store = await getUserProfileStore();
  } catch {
    return c.json({error: "identity layer unavailable"}, 503);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({error: "invalid JSON body"}, 400);
  }
  const {recoverMessageAddress} = await import("viem");
  const r = await setUsernameHandler({
    store,
    recover: ({message, signature}) =>
      recoverMessageAddress({message, signature}) as Promise<`0x${string}`>,
    rawAddress: c.req.param("address") ?? "",
    body,
    now: () => new Date(),
  });
  // After a successful write, the cached `/profile/:address` response is
  // stale (the userProfile block changed). Drop the entry from the cache so
  // the next read re-derives. Two cache keys exist per address (role=all and
  // role=creator); invalidate both.
  if (r.status === 200) {
    const lowered = (c.req.param("address") ?? "").toLowerCase() as `0x${string}`;
    profileResponseCache.delete(profileCacheKey(lowered, {role: "all"}));
    profileResponseCache.delete(profileCacheKey(lowered, {role: "creator"}));
  }
  return c.json(r.body as object, r.status as 200 | 400 | 401 | 409 | 500);
});

/// Epic 1.24 — identifier-aware profile lookup.
///
/// The route param `:identifier` accepts EITHER a 0x-prefixed 40-char
/// address OR a username. Disambiguation is by shape (`classifyIdentifier`).
/// Username path 404s if the handle doesn't resolve; address path preserves
/// the legacy "200 with all-zero shape for unknown wallets" behaviour
/// (spec §22 — avoid leaking participation status via HTTP code; the web
/// page applies its own no-activity gate to render a 404 page).
///
/// The response body extends the existing `/profile/:address` shape with a
/// `userProfile` block containing the username + display + hasUsername fields
/// (Epic 1.24). Existing callers that ignore unknown fields continue to work.
ponder.get("/profile/:identifier", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const raw = c.req.param("identifier") ?? "";

  // Resolve identifier → (address, profileRow). The userProfile store is
  // optional: if the identity layer is unavailable (no DATABASE_URL in dev),
  // address-shaped identifiers continue to resolve via a fallback path so
  // the legacy `/profile/:address` behaviour is preserved.
  let address: `0x${string}` | null = null;
  let profileRow: Awaited<ReturnType<UserProfileStore["getByAddress"]>> = null;
  // Bugbot M PR #102 pass-12: track whether the identity layer answered
  // this request. On a transient failure we previously attached a null-
  // derived `userProfile` block (`{hasUsername: false}`), which actively
  // claimed the user had no username — even if they actually had one.
  // Omitting the field instead lets the client distinguish "not known"
  // (field absent) from "explicitly no username" (`hasUsername: false`).
  let identityLayerOk = false;
  try {
    const store = await getUserProfileStore();
    const resolved = await resolveProfileIdentifier(store, raw);
    identityLayerOk = true;
    if (resolved === null) {
      // Address-shaped identifiers always resolve at the helper level;
      // null means username-not-found (or syntactically-invalid).
      const lowered = raw.toLowerCase();
      if (!isAddressLike(lowered)) {
        return c.json({error: "profile not found"}, 404);
      }
      // shouldn't happen — address-shaped should resolve. Defensive fallback.
      address = lowered as `0x${string}`;
      profileRow = null;
    } else {
      address = resolved.address;
      profileRow = resolved.profileRow;
    }
  } catch {
    // Identity layer unavailable. Address-shaped identifiers still work.
    const lowered = raw.toLowerCase();
    if (!isAddressLike(lowered)) {
      return c.json({error: "identity layer unavailable"}, 503);
    }
    address = lowered as `0x${string}`;
    profileRow = null;
    identityLayerOk = false;
  }

  const url = new URL(mw.req.url);
  const roleParam = url.searchParams.get("role");
  const role: ProfileRoleFilter = roleParam === "creator" ? "creator" : null;
  if (roleParam !== null && role === null) {
    return c.json({error: `unsupported role filter: ${roleParam}`}, 400);
  }
  const bypass = shouldBypassCache(mw);
  const r = await cached(
    profileResponseCache,
    profileCacheKey(address!, {role: role ?? "all"}),
    async () =>
      getProfileHandler(buildProfileQueries(c.db), address!, () => new Date(), {role}),
    {bypass},
  );
  mw.header("X-Cache", r.status);
  // Attach the userProfile block to a successful response. The legacy
  // /profile/:address shape grows a new object field; old clients that
  // ignore unknown fields are unaffected.
  if (r.value.status === 200) {
    const body = r.value.body as ProfileResponse;
    // Only attach the userProfile block when the identity layer answered.
    // A transient failure shouldn't actively flip `hasUsername` to false
    // for users who own a handle (PR #102 pass-12 fix).
    if (identityLayerOk) {
      return c.json(
        {
          ...body,
          userProfile: userProfileBlockFromRow(address!, profileRow ?? null),
        },
        200,
      );
    }
    return c.json(body, 200);
  }
  // Bugbot L PR #102 pass-5: this branch is currently unreachable —
  // `address!` is already validated by `isAddressLike` upstream, so
  // `getProfileHandler` cannot return its 400 path. The original code cast
  // status `as 200` which was misleading: if a future variant is added to
  // the handler (e.g. a 403 for soft-suspended addresses), the cast would
  // silently serve the error body with a wrong type annotation. Widen to
  // the actual contract so a new variant surfaces as a TS build failure
  // here instead of as a silent wire bug.
  return c.json(
    r.value.body as ProfileResponse | {error: string},
    r.value.status as 200 | 400,
  );
});

/// Epic 1.23 — per-token HP-component swap-impact drilldown. Powers the
/// admin console v2 expandable section under each HP-component mini-bar.
/// See `componentDeltas.ts` for the threshold + windowing rules.
ponder.get("/tokens/:address/component-deltas", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const raw = c.req.param("address") ?? "";
  const normalized = raw.toLowerCase();
  if (!isAddressLike(normalized)) {
    return c.json({error: "invalid address"}, 400);
  }
  const url = new URL(mw.req.url);
  const params = {
    limit: url.searchParams.get("limit") ?? undefined,
    threshold: url.searchParams.get("threshold") ?? undefined,
  };
  // Skip the cache layer entirely — the response is small, the underlying
  // tables churn on every swap, and the admin console only opens this
  // surface on demand. Adding a cache here would just add staleness without
  // a meaningful read-rate benefit.
  const r = await getComponentDeltasHandler(buildComponentDeltasQueries(c.db), normalized, params, {
    nowSec: () => Math.floor(Date.now() / 1000),
  });
  return c.json(r.body, r.status as 200 | 400);
});

/// Epic 1.23 — per-wallet holdings + projected rollover entitlement. Powers the
/// admin console v2 holdings panel + the filter-moment recap card. Open auth
/// (per-wallet self-service derived from public on-chain state). See
/// `holdings.ts` for the projection math + null-result semantics.
ponder.get("/wallets/:address/holdings", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const raw = c.req.param("address") ?? "";
  const normalized = raw.toLowerCase();
  if (!isAddressLike(normalized)) {
    return c.json({error: "invalid address"}, 400);
  }
  const bypass = shouldBypassCache(mw);
  const r = await cached(
    holdingsResponseCache,
    holdingsCacheKey(normalized as `0x${string}`),
    async () =>
      getHoldingsHandler(
        buildHoldingsQueries(c.db),
        normalized,
        () => Math.floor(Date.now() / 1000),
      ),
    {bypass},
  );
  mw.header("X-Cache", r.status);
  return c.json(r.value.body as HoldingsResponse | {error: string}, r.value.status as 200);
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
        // Epic 1.16: surface the on-chain post-settlement marker so /season consumers can
        // resolve "is the winner pool routing to POL now?" without dereferencing the locker.
        winnerSettledAt: row.winnerSettledAt ?? null,
        winner: row.winner ?? null,
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
        // Epic 1.18 — tie-break key for the scoring pass.
        createdAt: r.createdAt,
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
        createdAt: row.createdAt,
      };
      return detail;
    },
    creatorEarningsForToken: async (addr): Promise<CreatorEarningRow | null> => {
      const rows = await db
        .select()
        .from(creatorEarning)
        .where(eq(creatorEarning.token, addr))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        token: row.token,
        creator: row.creator,
        lifetimeAccrued: row.lifetimeAccrued,
        claimed: row.claimed,
        redirectedToTreasury: row.redirectedToTreasury,
        lastClaimAt: row.lastClaimAt ?? null,
        disabled: row.disabled,
        weightsVersion: row.weightsVersion,
      };
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
    /// Epic 1.22b — delegates to the shared `fetchProjectionInputsFromDb`
    /// helper so the REST, SSE, and writer-side projection fetches stay in
    /// lockstep. Bugbot M (PR #97): consolidated to one query path.
    projectionInputsForCohort: async (tokens, currentTime) => {
      return fetchProjectionInputsFromDb(db, tokens, currentTime);
    },
    /// Epic 1.25/1.26/1.27 — margin inputs for the season. Reads CUT and
    /// FINALIZE-tagged hpSnapshot rows for the cohort, joined to the `token`
    /// table to identify the winning row. Pre-CUT all three integers are null;
    /// post-CUT cutLineHp populates; post-FINALIZE winningHp + secondPlaceHp
    /// populate too. The cut line is `min(hp)` over CUT-tagged rows belonging
    /// to CUT-survivors (winner + finalists), where survivors are derived by
    /// bucketing each token's `liquidation.blockTimestamp` against the season's
    /// `Settlement` phase change — anything liquidated BEFORE Settlement was
    /// CUT-filtered. Bugbot PR #103: prior code keyed off `token.liquidated`
    /// directly, which incorrectly excluded finalists (liquidated at FINALIZE).
    marginInputsForSeason: async (seasonId) => {
      // Resolve season's winner address (if any).
      const seasonRows = await db
        .select()
        .from(season)
        .where(eq(season.id, seasonId))
        .limit(1);
      const seasonRow = seasonRows[0];
      if (!seasonRow) {
        return {cutLineHp: null, winningHp: null, secondPlaceHp: null};
      }
      const tokenRows = await db.select().from(token).where(eq(token.seasonId, seasonId));
      if (tokenRows.length === 0) {
        return {cutLineHp: null, winningHp: null, secondPlaceHp: null};
      }
      const tokenAddrs = tokenRows.map((r) => r.id);
      // Pull CUT and FINALIZE-tagged rows for the cohort.
      const cutOrFinalRows = await db
        .select()
        .from(hpSnapshot)
        .where(
          and(
            inArray(hpSnapshot.token, tokenAddrs),
            inArray(hpSnapshot.trigger, ["CUT", "FINALIZE"]),
          ),
        );
      // Cut-filtered set = tokens whose `liquidation.blockTimestamp` falls in
      // the CUT phase (before Settlement). Bugbot PR #103: the prior code
      // used `liquidated=true`, which conflates CUT-eliminated tokens with
      // FINALIZE-eliminated finalists — finalists were CUT-time survivors, so
      // their CUT-tagged HP belongs in the cut-line `min(hp)` calculation.
      const cutFilteredBySeason = await buildCutFilteredAddrsBySeasons(db, [seasonId]);
      const cutFilteredSet = cutFilteredBySeason.get(seasonId) ?? new Set<string>();
      let cutLineHp: number | null = null;
      let winningHp: number | null = null;
      let secondPlaceHp: number | null = null;
      const winnerAddr = seasonRow.winner ? seasonRow.winner.toLowerCase() : null;
      // Cut line = min(hp) over CUT-tagged rows for CUT-survivors (winner +
      // finalists). Excluding only CUT-filtered tokens; finalists' CUT HP is
      // load-bearing for the survivor floor.
      for (const r of cutOrFinalRows) {
        if (r.trigger === "CUT") {
          if (!cutFilteredSet.has(r.token.toLowerCase())) {
            if (cutLineHp === null || r.hp < cutLineHp) cutLineHp = r.hp;
          }
        }
      }
      // Winner HP + second-place HP from FINALIZE-tagged rows. The winner is
      // identified by `season.winner`; second place is the highest HP over
      // FINALIZE-tagged rows that aren't the winner.
      if (winnerAddr) {
        for (const r of cutOrFinalRows) {
          if (r.trigger !== "FINALIZE") continue;
          const lower = r.token.toLowerCase();
          if (lower === winnerAddr) {
            if (winningHp === null || r.hp > winningHp) winningHp = r.hp;
          } else {
            if (secondPlaceHp === null || r.hp > secondPlaceHp) secondPlaceHp = r.hp;
          }
        }
      }
      return {cutLineHp, winningHp, secondPlaceHp};
    },
  };
}

/// Lookup an arbitrary season by id. Used by `/season/:id` (Epic 1.25/1.26/1.27)
/// — distinct from `latestSeason` which always returns the highest id.
function buildSeasonByIdLookup(db: ApiDb): (id: bigint) => Promise<SeasonRow | null> {
  return async (id) => {
    const rows = await db.select().from(season).where(eq(season.id, id)).limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      startedAt: r.startedAt,
      phase: r.phase,
      totalPot: r.totalPot,
      bonusReserve: r.bonusReserve,
      winnerSettledAt: r.winnerSettledAt ?? null,
      winner: r.winner ?? null,
    };
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
        // Audit L-Indexer-4: legal labels are pinned by `HolderSnapshotTrigger`
        // in snapshotCadence.ts (the audit anchor + grep target). The schema
        // returns `string`, so this is a runtime equality check against the
        // canonical literals — no compile-time exhaustiveness here (bugbot
        // follow-up on PR #70 corrected the earlier draft's wrong claim about
        // type-system enforcement). Unknown labels silently fall through, which
        // is the right behaviour for forward-compat with a future contract that
        // adds a third trigger we haven't shipped wiring for yet.
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

/// Holdings-specific queries (Epic 1.23). One bulk read of `holderBalance` rows
/// for the wallet, joined to `token` + `season` so the handler has every flag
/// it needs without N+1 round-trips. CUT-trigger holderSnapshot lookups happen
/// per-filtered-token and are batched at the handler layer.
function buildHoldingsQueries(db: ApiDb): HoldingsQueries {
  return {
    holdingsForUser: async (wallet) => {
      // Pull every positive-balance row for the wallet. Zero-balance rows are
      // not deleted (see `holder_balance` schema comment), so we filter at
      // the query layer to keep wire shape clean.
      const balanceRows = await db
        .select()
        .from(holderBalance)
        .where(and(eq(holderBalance.holder, wallet), gte(holderBalance.balance, 1n)));
      if (balanceRows.length === 0) return [];

      const tokenAddrs = balanceRows.map((r) => r.token);
      const tokenRows = await db
        .select()
        .from(token)
        .where(inArray(token.id, tokenAddrs));
      const tokenById = new Map<string, (typeof tokenRows)[number]>();
      for (const t of tokenRows) tokenById.set(t.id.toLowerCase(), t);

      const seasonIds = [...new Set(tokenRows.map((t) => t.seasonId))];
      const seasonRows = await Promise.all(
        seasonIds.map((id) => db.select().from(season).where(eq(season.id, id)).limit(1)),
      );
      const seasonById = new Map<bigint, (typeof seasonRows)[number][number] | undefined>();
      for (const rows of seasonRows) {
        const s = rows[0];
        if (s) seasonById.set(s.id, s);
      }

      const out: HoldingTokenRow[] = [];
      for (const b of balanceRows) {
        const t = tokenById.get(b.token.toLowerCase());
        // Indexer hadn't ingested the token yet (race between Transfer + Deploy
        // event ordering on a fresh launch). Skip — the next poll will pick it
        // up. Better than surfacing a half-hydrated row.
        if (!t) continue;
        const s = seasonById.get(t.seasonId);
        out.push({
          token: t.id,
          symbol: t.symbol,
          seasonId: t.seasonId,
          liquidated: t.liquidated,
          isFinalist: t.isFinalist,
          liquidationProceeds: t.liquidationProceeds ?? null,
          balance: b.balance,
          seasonWinner: s?.winner ?? null,
          winnerSettledAt: s?.winnerSettledAt ?? null,
        });
      }
      return out;
    },
    cutSnapshotForToken: async (tokenAddr, wallet): Promise<CutSnapshotForToken | null> => {
      // CUT-trigger snapshots for the token: one row per holder above dust at
      // first-cut. Sum across them for `totalCutBalance`; lift the wallet's
      // own row for `walletCutBalance`. Both come from the same query — one
      // round-trip per filtered token.
      const rows = await db
        .select()
        .from(holderSnapshot)
        .where(and(eq(holderSnapshot.token, tokenAddr), eq(holderSnapshot.trigger, "CUT")));
      if (rows.length === 0) return null;
      let total = 0n;
      let walletBalance = 0n;
      const walletLower = wallet.toLowerCase();
      for (const r of rows) {
        total += r.balance;
        if (r.holder.toLowerCase() === walletLower) walletBalance = r.balance;
      }
      return {walletCutBalance: walletBalance, totalCutBalance: total};
    },
  };
}

/// Component-deltas queries (Epic 1.23). Two indexes are touched:
///   - `hp_snapshot` — recent rows for the token, used to compute deltas.
///   - `swap` — joined on `blockNumber` to attach taker / tx / WETH context to
///     trigger=SWAP rows.
function buildComponentDeltasQueries(db: ApiDb): ComponentDeltasQueries {
  return {
    recentSnapshots: async (tokenAddr, windowSize): Promise<SnapshotRow[]> => {
      const rows = await db
        .select()
        .from(hpSnapshot)
        .where(eq(hpSnapshot.token, tokenAddr))
        .orderBy(desc(hpSnapshot.snapshotAtSec))
        .limit(windowSize);
      return rows.map((r) => ({
        token: r.token,
        timestamp: Number(r.snapshotAtSec),
        trigger: r.trigger,
        blockNumber: r.blockNumber,
        velocity: r.velocity,
        effectiveBuyers: r.effectiveBuyers,
        stickyLiquidity: r.stickyLiquidity,
        retention: r.retention,
        momentum: r.momentum,
      }));
    },
    swapsForBlocks: async (tokenAddr, blockNumbers): Promise<SwapJoinRow[]> => {
      if (blockNumbers.length === 0) return [];
      const rows = await db
        .select()
        .from(swap)
        .where(
          and(eq(swap.token, tokenAddr), inArray(swap.blockNumber, [...blockNumbers])),
        );
      return rows.map((r) => ({
        txHash: r.txHash,
        taker: r.taker,
        side: r.side as "BUY" | "SELL",
        wethValue: r.wethValue,
        blockNumber: r.blockNumber,
        blockTimestamp: r.blockTimestamp,
      }));
    },
  };
}

// ============================================================ Graveyard + winners adapters (Epic 1.25/1.26/1.27)

/// Returns lowercased token addresses that were filtered AT CUT (h96), as
/// distinct from finalists who were filtered at FINALIZE (h168).
///
/// Bugbot PR #103: the cut-line `min(hp)` calculation must include finalists'
/// CUT-tagged HP rows — finalists were CUT-time survivors, so their HP at h96
/// belongs in the survivor min. The earlier code excluded all `liquidated=true`
/// tokens, which collapsed the survivor set to just the winner and inflated
/// `cutLineHp` (causing real near-misses to fail the `isNearMiss` gate).
///
/// Bucketing rule: `liquidation.blockTimestamp < settlementPhaseTs` ⇒
/// CUT-filtered. The `Settlement` phase change marks the FINALIZE moment, so
/// any liquidation BEFORE that boundary fired during CUT phase. If the season
/// hasn't reached `Settlement` yet, every liquidation is CUT-filtered (no
/// finalists exist before FINALIZE).
async function buildCutFilteredAddrsBySeasons(
  db: ApiDb,
  seasonIds: ReadonlyArray<bigint>,
): Promise<Map<bigint, Set<string>>> {
  const out = new Map<bigint, Set<string>>();
  if (seasonIds.length === 0) return out;
  // Drizzle's `inArray` rejects readonly arrays — copy to mutable.
  const mutableSeasonIds = [...seasonIds];
  const settlementRows = await db
    .select()
    .from(phaseChange)
    .where(
      and(
        inArray(phaseChange.seasonId, mutableSeasonIds),
        eq(phaseChange.newPhase, "Settlement"),
      ),
    );
  const settlementBySeason = new Map<bigint, bigint>();
  for (const r of settlementRows) {
    // Earliest Settlement transition wins (defensive — there should be only one).
    const cur = settlementBySeason.get(r.seasonId);
    if (cur === undefined || r.blockTimestamp < cur) {
      settlementBySeason.set(r.seasonId, r.blockTimestamp);
    }
  }
  const liqRows = await db
    .select()
    .from(liquidation)
    .where(inArray(liquidation.seasonId, mutableSeasonIds));
  for (const sid of mutableSeasonIds) out.set(sid, new Set<string>());
  for (const lr of liqRows) {
    const ts = settlementBySeason.get(lr.seasonId);
    if (ts === undefined || lr.blockTimestamp < ts) {
      out.get(lr.seasonId)?.add(lr.token.toLowerCase());
    }
  }
  return out;
}

/// Bulk creator-profile lookup. Iterates the unique address set and calls
/// `getByAddress` per entry. The off-chain identity layer is optional — if
/// `DATABASE_URL` isn't set in dev, the lookup short-circuits to an empty map
/// and the response degrades to address-only display.
async function fetchCreatorProfiles(
  addresses: ReadonlyArray<`0x${string}`>,
): Promise<Map<string, {username: string | null; avatarUrl: string | null}>> {
  const out = new Map<string, {username: string | null; avatarUrl: string | null}>();
  if (addresses.length === 0) return out;
  let store: UserProfileStore;
  try {
    store = await getUserProfileStore();
  } catch {
    return out;
  }
  // Genesis volume: per-page address sets are small (≤50). Sequential
  // `getByAddress` is fine; switch to a batch query if this gets hot.
  await Promise.all(
    addresses.map(async (a) => {
      const lower = a.toLowerCase() as `0x${string}`;
      const row = await store.getByAddress(lower).catch(() => null);
      if (row && row.username !== null) {
        out.set(lower, {
          username: row.usernameDisplay ?? row.username,
          avatarUrl: null, // Forward-compat — today avatars are derived client-side from address.
        });
      }
    }),
  );
  return out;
}

/// `/graveyard` queries adapter. Pulls every filtered token + season cohort
/// joins. For genesis volumes (≤12 launches × ~10 seasons = 120 rows) the
/// "no pagination at the SQL layer" approach is fine; if the archive ever
/// grows past ~1k rows, push pagination into the SELECT instead of in JS.
function buildGraveyardQueries(db: ApiDb): GraveyardQueries {
  return {
    filteredTokens: async () => {
      // 1. All filtered tokens.
      const filteredRows = await db
        .select()
        .from(token)
        .where(eq(token.liquidated, true));
      if (filteredRows.length === 0) return [];

      const tokenAddrs = filteredRows.map((r) => r.id);
      const seasonIds = [...new Set(filteredRows.map((r) => r.seasonId))];

      // 2. Liquidation rows (one per filtered token) — gives us `filteredAt`.
      const liquidationRows = await db
        .select()
        .from(liquidation)
        .where(inArray(liquidation.token, tokenAddrs));
      const liquidationByToken = new Map<string, (typeof liquidationRows)[number]>();
      for (const lr of liquidationRows) {
        liquidationByToken.set(lr.token.toLowerCase(), lr);
      }

      // 3. Per-token CUT/FINALIZE-tagged HP snapshots — gives us finalHp + filterRound.
      const triggerRows = await db
        .select()
        .from(hpSnapshot)
        .where(
          and(
            inArray(hpSnapshot.token, tokenAddrs),
            inArray(hpSnapshot.trigger, ["CUT", "FINALIZE"]),
          ),
        );
      // Pick the trigger row that represents the actual filter moment per
      // token. Bugbot PR #103 pass-7: every token in the cohort has BOTH a
      // CUT-tagged and a FINALIZE-tagged row (the writer is cohort-wide). The
      // authoritative filter row is:
      //   - finalists → FINALIZE (they survived CUT, lost at h168)
      //   - everyone else (CUT-filtered) → CUT
      // For ties within a trigger, take the earliest.
      type TriggerCandidate = {
        hp: number;
        rank: number;
        trigger: "CUT" | "FINALIZE";
        ts: bigint;
      };
      const cutByToken = new Map<string, TriggerCandidate>();
      const finalizeByToken = new Map<string, TriggerCandidate>();
      for (const tr of triggerRows) {
        const lower = tr.token.toLowerCase();
        const candidate: TriggerCandidate = {
          hp: tr.hp,
          rank: tr.rank,
          trigger: tr.trigger as "CUT" | "FINALIZE",
          ts: tr.snapshotAtSec,
        };
        const map = tr.trigger === "CUT" ? cutByToken : finalizeByToken;
        const existing = map.get(lower);
        if (!existing || tr.snapshotAtSec < existing.ts) {
          map.set(lower, candidate);
        }
      }
      const isFinalistByToken = new Map<string, boolean>();
      for (const r of filteredRows) {
        isFinalistByToken.set(r.id.toLowerCase(), r.isFinalist);
      }
      const triggerByToken = new Map<string, TriggerCandidate>();
      for (const lower of new Set([...cutByToken.keys(), ...finalizeByToken.keys()])) {
        const cut = cutByToken.get(lower);
        const finalize = finalizeByToken.get(lower);
        const finalist = isFinalistByToken.get(lower) ?? false;
        const picked = finalist ? finalize ?? cut : cut ?? finalize;
        if (picked) triggerByToken.set(lower, picked);
      }

      // 4. Per-token peakHp — `max(hp)` across the full hp series. Bugbot
      // PR #103 pass-9: pushed the aggregate into SQL so we don't pull
      // hundreds of BLOCK_TICK / SWAP / HOLDER_SNAPSHOT rows per token into
      // JS just to take the max.
      const peakRows = await db
        .select({token: hpSnapshot.token, peakHp: max(hpSnapshot.hp)})
        .from(hpSnapshot)
        .where(inArray(hpSnapshot.token, tokenAddrs))
        .groupBy(hpSnapshot.token);
      const peakByToken = new Map<string, number>();
      for (const pr of peakRows) {
        peakByToken.set(pr.token.toLowerCase(), Number(pr.peakHp ?? 0));
      }

      // 5. Holders-at-filter — count of distinct CUT-tagged holderSnapshot rows
      // per token. Bugbot PR #103 pass-3: detail and index must agree on this
      // count. Use CUT-tagged rows for ALL graveyard tokens because:
      //   - CUT-filtered tokens: only have CUT-tagged holder data (the cut
      //     event handler in SeasonVault writes CUT-tagged rows for survivors).
      //   - Finalists (FINALIZE-filtered): only CUT-tagged holder data exists
      //     for them too — FINALIZE-tagged holderSnapshot is winner-only.
      // Matching on `trigger.trigger` (the filter round) silently produced 0
      // for finalists; CUT-only is the actual ground truth across both rounds.
      const holderRows = await db
        .select()
        .from(holderSnapshot)
        .where(
          and(
            inArray(holderSnapshot.token, tokenAddrs),
            eq(holderSnapshot.trigger, "CUT"),
          ),
        );
      const holdersByToken = new Map<string, number>();
      for (const hr of holderRows) {
        const lower = hr.token.toLowerCase();
        holdersByToken.set(lower, (holdersByToken.get(lower) ?? 0) + 1);
      }

      // 6. Per-season cut line — min(hp) over CUT-tagged rows for CUT-survivors
      // (winner + finalists). Bugbot PR #103: skipping the entire `liquidated`
      // set excluded finalists, collapsing the survivor pool to just the
      // winner and inflating the cut line. Finalists were CUT-time survivors;
      // their CUT-tagged HP rows belong in the floor.
      const allSeasonTokens = await db
        .select()
        .from(token)
        .where(inArray(token.seasonId, seasonIds));
      const cutFilteredBySeason = await buildCutFilteredAddrsBySeasons(db, seasonIds);
      const allSeasonAddrs = allSeasonTokens.map((r) => r.id);
      const allCutRows = await db
        .select()
        .from(hpSnapshot)
        .where(
          and(
            inArray(hpSnapshot.token, allSeasonAddrs),
            eq(hpSnapshot.trigger, "CUT"),
          ),
        );
      const cutLineBySeason = new Map<bigint, number | null>();
      // Map every token → seasonId for the cut-line bucketing.
      const seasonByToken = new Map<string, bigint>();
      for (const t of allSeasonTokens) seasonByToken.set(t.id.toLowerCase(), t.seasonId);
      for (const cr of allCutRows) {
        const lower = cr.token.toLowerCase();
        const sid = seasonByToken.get(lower);
        if (sid === undefined) continue;
        const cutFiltered = cutFilteredBySeason.get(sid);
        if (cutFiltered?.has(lower)) continue; // skip CUT-filtered only; finalists stay
        const cur = cutLineBySeason.get(sid);
        if (cur === undefined || cur === null || cr.hp < cur) {
          cutLineBySeason.set(sid, cr.hp);
        }
      }

      // Compose source rows.
      return filteredRows.map((r) => {
        const lower = r.id.toLowerCase();
        const trigger = triggerByToken.get(lower);
        const liq = liquidationByToken.get(lower);
        return {
          address: r.id,
          symbol: r.symbol,
          seasonId: r.seasonId,
          creator: r.creator,
          isFinalist: r.isFinalist,
          liquidationProceeds: r.liquidationProceeds ?? null,
          filteredAt: liq?.blockTimestamp ?? null,
          peakHp: peakByToken.get(lower) ?? 0,
          finalHp: trigger?.hp ?? 0,
          filterRound: trigger?.trigger ?? null,
          holdersAtFilter: holdersByToken.get(lower) ?? 0,
          cutLineHp: cutLineBySeason.get(r.seasonId) ?? null,
          // 0 in storage means "rank unset" — surface as null so the UI
          // renders "rank #—" rather than "rank #0".
          finalRank: trigger && trigger.rank > 0 ? trigger.rank : null,
        };
      });
    },
    creatorProfilesFor: fetchCreatorProfiles,
  };
}

/// `/graveyard/:address` queries adapter — fan-out reads against the existing
/// indexes for the per-token detail view.
function buildGraveyardDetailQueries(db: ApiDb): GraveyardDetailQueries {
  return {
    tokenAndSeason: async (addr) => {
      const tokenRows = await db.select().from(token).where(eq(token.id, addr)).limit(1);
      const t = tokenRows[0];
      if (!t) return null;
      const seasonRows = await db.select().from(season).where(eq(season.id, t.seasonId)).limit(1);
      const s = seasonRows[0];
      if (!s) return null;
      return {
        token: {
          address: t.id,
          symbol: t.symbol,
          name: t.name,
          creator: t.creator,
          seasonId: t.seasonId,
          isProtocolLaunched: t.isProtocolLaunched,
          isFinalist: t.isFinalist,
          liquidated: t.liquidated,
          createdAt: t.createdAt,
        },
        season: {
          id: s.id,
          startedAt: s.startedAt,
          finalizedAt: s.finalizedAt ?? null,
          winner: s.winner ?? null,
        },
      };
    },
    hpSeriesForToken: async (addr) => {
      const rows = await db
        .select()
        .from(hpSnapshot)
        .where(eq(hpSnapshot.token, addr))
        .orderBy(hpSnapshot.snapshotAtSec);
      return rows.map((r) => ({
        timestamp: r.snapshotAtSec,
        hp: r.hp,
        trigger: r.trigger,
      }));
    },
    holderSeriesForToken: async (addr) => {
      // CUT-tagged holderSnapshot rows only — see the matching comment in
      // buildGraveyardQueries.filteredTokens (bugbot PR #103 pass-3). Detail
      // and index must agree on the holder count; FINALIZE-tagged rows in
      // holder_snapshot are winner-only and never apply to graveyard tokens.
      const rows = await db
        .select()
        .from(holderSnapshot)
        .where(and(eq(holderSnapshot.token, addr), eq(holderSnapshot.trigger, "CUT")));
      const byTs = new Map<bigint, number>();
      for (const r of rows) {
        byTs.set(r.blockTimestamp, (byTs.get(r.blockTimestamp) ?? 0) + 1);
      }
      const points = [...byTs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([timestamp, holders]) => ({timestamp, holders}));
      return points;
    },
    lpEventsForToken: async (addr) => {
      // LP events: in genesis the only LP event surfaced per token is the
      // BURN at filter time (the unwind). Mint events fire from
      // FilterFactory at deploy but aren't yet in a dedicated table — pull
      // from `liquidation` for now (BURN side). Future work: source MINT
      // events from FilterFactory deploy logs.
      const rows = await db
        .select()
        .from(liquidation)
        .where(eq(liquidation.token, addr));
      return rows.map((r) => ({
        timestamp: r.blockTimestamp,
        kind: "BURN" as const,
        amountWeth: r.wethOut,
      }));
    },
    cutLineForSeason: async (seasonId) => {
      // Cut line = min(hp) over CUT-tagged rows for CUT-survivors (winner +
      // finalists). Bugbot PR #103: don't exclude finalists; their CUT HP is
      // the load-bearing floor for the survivor pool.
      const seasonRows = await db.select().from(season).where(eq(season.id, seasonId)).limit(1);
      if (!seasonRows[0]) return null;
      const cohortTokens = await db.select().from(token).where(eq(token.seasonId, seasonId));
      if (cohortTokens.length === 0) return null;
      const cutFilteredBySeason = await buildCutFilteredAddrsBySeasons(db, [seasonId]);
      const cutFilteredAddrs = cutFilteredBySeason.get(seasonId) ?? new Set<string>();
      const cohortAddrs = cohortTokens.map((r) => r.id);
      const cutRows = await db
        .select()
        .from(hpSnapshot)
        .where(
          and(
            inArray(hpSnapshot.token, cohortAddrs),
            eq(hpSnapshot.trigger, "CUT"),
          ),
        );
      let cutLine: number | null = null;
      for (const r of cutRows) {
        if (cutFilteredAddrs.has(r.token.toLowerCase())) continue;
        if (cutLine === null || r.hp < cutLine) cutLine = r.hp;
      }
      return cutLine;
    },
    finalRankForToken: async (addr, isFinalist) => {
      // Bugbot PR #103 pass-8: pick the trigger row that matches the token's
      // actual filter event — CUT row for CUT-filtered tokens, FINALIZE row
      // for finalists. Sorting purely by snapshotAtSec returned FINALIZE for
      // every token (it's strictly later), but FINALIZE-row rank is 0 for
      // already-liquidated CUT-filtered tokens, so the function returned null
      // when it should have returned the CUT-row rank.
      const wantTrigger: "CUT" | "FINALIZE" = isFinalist ? "FINALIZE" : "CUT";
      const primary = await db
        .select()
        .from(hpSnapshot)
        .where(and(eq(hpSnapshot.token, addr), eq(hpSnapshot.trigger, wantTrigger)))
        .orderBy(desc(hpSnapshot.snapshotAtSec))
        .limit(1);
      let r = primary[0];
      if (!r) {
        // Defensive fallback: if the preferred trigger row isn't indexed yet,
        // try the other trigger so the rank surface degrades gracefully
        // rather than dropping to null on partial indexer state.
        const otherTrigger: "CUT" | "FINALIZE" = isFinalist ? "CUT" : "FINALIZE";
        const fallback = await db
          .select()
          .from(hpSnapshot)
          .where(and(eq(hpSnapshot.token, addr), eq(hpSnapshot.trigger, otherTrigger)))
          .orderBy(desc(hpSnapshot.snapshotAtSec))
          .limit(1);
        r = fallback[0];
      }
      if (!r) return null;
      return r.rank > 0 ? r.rank : null;
    },
    creatorProfile: async (addr) => {
      let store: UserProfileStore;
      try {
        store = await getUserProfileStore();
      } catch {
        return null;
      }
      const row = await store.getByAddress(addr).catch(() => null);
      if (!row || row.username === null) return null;
      return {username: row.usernameDisplay ?? row.username, avatarUrl: null};
    },
  };
}

/// `/winners` queries adapter.
function buildWinnersQueries(db: ApiDb): WinnersQueries {
  return {
    winnerTokens: async () => {
      // Bugbot PR #103 pass-3: prior implementation issued `1 + 3N` DB queries
      // (token + cohort + FINALIZE-rows per season). Batched to 4 total: one
      // pass each over season, token (winners), token (cohort), hpSnapshot.
      const finalizedSeasons = await db.select().from(season);
      const winnerSeasons = finalizedSeasons.filter((s) => s.winner !== null);
      if (winnerSeasons.length === 0) return [];
      const winnerAddrs = winnerSeasons.map((s) => s.winner!);
      const seasonIds = winnerSeasons.map((s) => s.id);
      const [winnerTokenRows, cohortTokens] = await Promise.all([
        db.select().from(token).where(inArray(token.id, winnerAddrs)),
        db.select().from(token).where(inArray(token.seasonId, seasonIds)),
      ]);
      const cohortAddrs = cohortTokens.map((r) => r.id);
      const finalizeRows = cohortAddrs.length === 0 ? [] : await db
        .select()
        .from(hpSnapshot)
        .where(
          and(
            inArray(hpSnapshot.token, cohortAddrs),
            eq(hpSnapshot.trigger, "FINALIZE"),
          ),
        );
      const winnerByAddr = new Map(winnerTokenRows.map((r) => [r.id.toLowerCase(), r]));
      const cohortBySeason = new Map<bigint, typeof cohortTokens>();
      for (const c of cohortTokens) {
        const arr = cohortBySeason.get(c.seasonId) ?? [];
        arr.push(c);
        cohortBySeason.set(c.seasonId, arr);
      }
      const finalizeBySeason = new Map<bigint, typeof finalizeRows>();
      const seasonByToken = new Map<string, bigint>();
      for (const c of cohortTokens) seasonByToken.set(c.id.toLowerCase(), c.seasonId);
      for (const fr of finalizeRows) {
        const sid = seasonByToken.get(fr.token.toLowerCase());
        if (sid === undefined) continue;
        const arr = finalizeBySeason.get(sid) ?? [];
        arr.push(fr);
        finalizeBySeason.set(sid, arr);
      }
      const out: Awaited<ReturnType<WinnersQueries["winnerTokens"]>> = [];
      for (const s of winnerSeasons) {
        const winner = s.winner!;
        const t = winnerByAddr.get(winner.toLowerCase());
        if (!t) continue;
        let winningHp = 0;
        let secondPlaceHp: number | null = null;
        const winnerLower = winner.toLowerCase();
        const seasonFinalizeRows = finalizeBySeason.get(s.id) ?? [];
        for (const fr of seasonFinalizeRows) {
          const lower = fr.token.toLowerCase();
          if (lower === winnerLower) {
            if (fr.hp > winningHp) winningHp = fr.hp;
          } else {
            if (secondPlaceHp === null || fr.hp > secondPlaceHp) secondPlaceHp = fr.hp;
          }
        }
        out.push({
          address: t.id,
          symbol: t.symbol,
          seasonId: s.id,
          creator: t.creator,
          settledAt: s.winnerSettledAt ?? null,
          winningHp,
          secondPlaceHp,
          // Spec §11.4 reserve aggregation isn't yet wired into a per-winner
          // index; surface 0n until that layer lands. Same for current
          // mcap (V4 reads pending). The web layer renders these as "—".
          currentReserveWei: 0n,
          currentMcapWei: 0n,
        });
      }
      return out;
    },
    creatorProfilesFor: fetchCreatorProfiles,
  };
}

/// `/winners/:address/metrics` queries adapter. Today the reserve / fee /
/// holder time series rely on aggregates we can derive from existing tables;
/// for surfaces that aren't yet indexed (e.g. POL routing per-day rollups),
/// we return empty arrays so the UI renders "no data yet" rather than 404.
function buildWinnerMetricsQueries(db: ApiDb): WinnerMetricsQueries {
  return {
    winnerSummary: async (addr) => {
      const tokenRows = await db.select().from(token).where(eq(token.id, addr)).limit(1);
      const t = tokenRows[0];
      if (!t) return null;
      const seasonRows = await db.select().from(season).where(eq(season.id, t.seasonId)).limit(1);
      const s = seasonRows[0];
      if (!s || !s.winner) return null;
      // Confirm this address is actually the season's winner.
      if (s.winner.toLowerCase() !== addr.toLowerCase()) return null;
      // Bugbot PR #103 pass-9: align with `winnerTokens`, which takes
      // max(hp) over FINALIZE rows. The two surfaces previously disagreed
      // when duplicate FINALIZE rows existed (latest-by-snapshotAtSec vs
      // max-by-hp). Both now use the SQL max aggregate.
      const finalizeRows = await db
        .select({peakHp: max(hpSnapshot.hp)})
        .from(hpSnapshot)
        .where(
          and(
            eq(hpSnapshot.token, addr),
            eq(hpSnapshot.trigger, "FINALIZE"),
          ),
        );
      const winningHp = Number(finalizeRows[0]?.peakHp ?? 0);
      return {
        address: t.id,
        symbol: t.symbol,
        name: t.name,
        seasonId: t.seasonId,
        creator: t.creator,
        settledAt: s.winnerSettledAt ?? null,
        winningHp,
      };
    },
    runnerUpForSeason: async (seasonId) => {
      const seasonRows = await db.select().from(season).where(eq(season.id, seasonId)).limit(1);
      const s = seasonRows[0];
      if (!s || !s.winner) return null;
      const cohort = await db.select().from(token).where(eq(token.seasonId, seasonId));
      const cohortAddrs = cohort.map((r) => r.id);
      // Bugbot PR #103 pass-10: drizzle's `inArray([])` generates invalid
      // SQL (`WHERE col IN ()`), so guard the empty case explicitly. Mirrors
      // the pattern in `winnerTokens`.
      if (cohortAddrs.length === 0) return null;
      const finalizeRows = await db
        .select()
        .from(hpSnapshot)
        .where(
          and(
            inArray(hpSnapshot.token, cohortAddrs),
            eq(hpSnapshot.trigger, "FINALIZE"),
          ),
        );
      let bestAddr: `0x${string}` | null = null;
      let bestHp = -1;
      const winnerLower = s.winner.toLowerCase();
      for (const fr of finalizeRows) {
        const lower = fr.token.toLowerCase();
        if (lower === winnerLower) continue;
        if (fr.hp > bestHp) {
          bestHp = fr.hp;
          bestAddr = fr.token;
        }
      }
      if (!bestAddr || bestHp < 0) return null;
      const tRows = await db.select().from(token).where(eq(token.id, bestAddr)).limit(1);
      const t = tRows[0];
      if (!t) return null;
      return {
        address: t.id,
        symbol: t.symbol,
        creator: t.creator,
        finalHp: bestHp,
      };
    },
    reserveSeriesForToken: async () => {
      // Spec §11.4 — Filter Fund Liquidity Reserve growth. The post-settlement
      // POL routing (Epic 1.16, PR #90) records per-fee-event entries in
      // `feeAccrual` with `routing = "POST_SETTLEMENT"`, summing into the POL
      // vault. Roll up by day for the chart.
      // Returns empty for now; the per-day rollup is left as the
      // higher-level chart render — a follow-up can sample by day from the
      // `feeAccrual` table to populate this series.
      return [];
    },
    feeAccrualSeries: async (addr) => {
      // Per-day feeAccrual rollup — creator slice + POL slice.
      const rows = await db
        .select()
        .from(feeAccrual)
        .where(eq(feeAccrual.token, addr))
        .orderBy(feeAccrual.blockTimestamp);
      // Bucket by day (86400s).
      const DAY_SEC = 86400n;
      const byDay = new Map<bigint, {creator: bigint; pol: bigint}>();
      for (const r of rows) {
        const bucket = (r.blockTimestamp / DAY_SEC) * DAY_SEC;
        const cur = byDay.get(bucket) ?? {creator: 0n, pol: 0n};
        cur.creator += r.toCreator;
        // Post-settlement routing: `toVault` lands in POLVault per spec §9.4.
        if (r.routing === "POST_SETTLEMENT") cur.pol += r.toVault;
        byDay.set(bucket, cur);
      }
      // Cumulative across days (the chart line is monotonically growing).
      const sorted = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      let cumCreator = 0n;
      let cumPol = 0n;
      return sorted.map(([timestamp, d]) => {
        cumCreator += d.creator;
        cumPol += d.pol;
        return {
          timestamp,
          creatorEarnedWei: cumCreator,
          polTopUpWei: cumPol,
        };
      });
    },
    holderRetentionSeries: async () => {
      // Holder retention since settlement. Anchor: holders at FINALIZE.
      // Implementation pending — sample `holderBalance` per day post-
      // settlement against the FINALIZE-trigger holderSnapshot baseline.
      return [];
    },
    creatorProfile: async (addr) => {
      let store: UserProfileStore;
      try {
        store = await getUserProfileStore();
      } catch {
        return null;
      }
      const row = await store.getByAddress(addr).catch(() => null);
      if (!row || row.username === null) return null;
      return {username: row.usernameDisplay ?? row.username, avatarUrl: null};
    },
  };
}

/// Local alias for Ponder's API context db handle.
type ApiDb = ApiContext["db"];
