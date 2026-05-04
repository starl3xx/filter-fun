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
import {and, count, desc, eq, gte, inArray, lte} from "@ponder/core";
import {cors} from "hono/cors";

import {
  bonusClaim,
  creatorEarning,
  creatorLock,
  holderBalance,
  holderSnapshot,
  hpSnapshot,
  launchEscrowSummary,
  pendingRefund,
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

import {isAddressLike} from "./builders.js";
import {cached} from "./cache.js";
import {loadCorsConfigFromEnv, originAllowed} from "./cors.js";
import {toMwContext} from "./mwContext.js";
import {checkAndLogCadence, consoleCadenceLogger} from "./snapshotCadence.js";
import {
  getCreatorEarningsHandler,
  getReadinessHandler,
  getSeasonHandler,
  getTokenDetailHandler,
  getTokensHandler,
  type ApiQueries,
  type BagLockRow,
  type CreatorEarningRow,
  type TokenDetailRow,
} from "./handlers.js";
import {fetchProjectionInputsFromDb} from "./hp.js";
import {ensureEventsEngineStarted, eventsEngineRunning} from "./events/index.js";
import {buildScoringWeightsResponse} from "./scoringWeights.js";
import {getTokenHistoryHandler, type HistoryQueries, type HpSnapshotRow} from "./history.js";
import {
  applyGetRateLimit,
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
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    exposeHeaders: ["RateLimit-Remaining", "Retry-After", "X-Cache"],
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

/// Epic 1.16 (spec §10.3 + §10.6): per-token creator-fee surface. Powers the creator
/// admin console "claim past tokens" flow + the cost/ROI calculator's winner long-tail
/// projection. Returns a zero-shaped payload for tokens that haven't accrued yet so the
/// UI's still-earning badge can render against any token without special-casing absence.
ponder.get("/tokens/:address/creator-earnings", async (c) => {
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const result = await getCreatorEarningsHandler(buildQueries(c.db), c.req.param("address") ?? "");
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
  const limited = applyGetRateLimit(mw);
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
  const limited = applyGetRateLimit(mw);
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
  const limited = applyGetRateLimit(mw);
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
  const limited = applyGetRateLimit(mw);
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
  const url = new URL(mw.req.url);
  const roleParam = url.searchParams.get("role");
  // Epic 1.23: `?role=creator` narrows `createdTokens` to tokens this wallet
  // created (vs. the default which already keys on creator anyway, but the
  // explicit param lets the admin console request a stable filter for the
  // past-tokens panel without depending on default behaviour).
  const role: ProfileRoleFilter = roleParam === "creator" ? "creator" : null;
  if (roleParam !== null && role === null) {
    return c.json({error: `unsupported role filter: ${roleParam}`}, 400);
  }
  const bypass = shouldBypassCache(mw);
  const r = await cached(
    profileResponseCache,
    profileCacheKey(normalized as `0x${string}`, {role: role ?? "all"}),
    async () =>
      getProfileHandler(buildProfileQueries(c.db), normalized, () => new Date(), {role}),
    {bypass},
  );
  mw.header("X-Cache", r.status);
  return c.json(r.value.body as ProfileResponse | {error: string}, r.value.status as 200);
});

/// Epic 1.23 — per-token HP-component swap-impact drilldown. Powers the
/// admin console v2 expandable section under each HP-component mini-bar.
/// See `componentDeltas.ts` for the threshold + windowing rules.
ponder.get("/tokens/:address/component-deltas", async (c) => {
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
  const limited = applyGetRateLimit(mw);
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

/// Local alias for Ponder's API context db handle.
type ApiDb = ApiContext["db"];
