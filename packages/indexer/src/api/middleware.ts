/// HTTP middleware for the indexer API: rate-limit + cache header plumbing.
///
/// Singleton state lives at module scope so both `src/api/index.ts` (the GET routes) and
/// `src/api/events/index.ts` (the SSE route) share one rate-limit budget per IP. Without a
/// shared singleton, a client could open 5 SSE streams *and* 60 GETs/min — twice the
/// intended pressure on the indexer.
///
/// Pure helpers in `cache.ts` and `ratelimit.ts` do the actual bookkeeping. This module
/// is only concerned with extracting context from a Hono request (IP from socket /
/// X-Forwarded-For, cache key from URL params), wiring response headers, and shaping the
/// 429 response.

/// Hono's `Context` is generic over bindings + variables. Ponder narrows those generics on
/// its routes, which makes a strict `Context` import incompatible with route-side calls
/// without casts at every site. We type middleware helpers against a structural subset of
/// the API we actually use — header reading/writing, URL access, JSON response building,
/// and the `c.env` peek for IP resolution. That's narrower than `Context` from hono and
/// works against any compatible context (Ponder's, Hono's, or test doubles).
export interface MwContext {
  req: {
    url: string;
    header: (name: string) => string | undefined;
  };
  header: (name: string, value: string) => void;
  json: (body: unknown, status?: number) => Response;
  env?: unknown;
}

import {
  loadCacheConfigFromEnv,
  LruTtlCache,
  type CacheConfig,
} from "./cache.js";
import {
  consumeBucket,
  loadRateLimitConfigFromEnv,
  makeBucketState,
  makeConnectionState,
  pruneBuckets,
  releaseConnection,
  resolveClientIp,
  tryClaimConnection,
  type RateLimitConfig,
  type TokenBucketState,
  type ConnectionState,
} from "./ratelimit.js";

// ============================================================ Singletons

const rateCfg: RateLimitConfig = loadRateLimitConfigFromEnv();
const cacheCfg: CacheConfig = loadCacheConfigFromEnv();

const bucketState: TokenBucketState = makeBucketState();
const connectionState: ConnectionState = makeConnectionState();

/// Periodic GC for the per-IP bucket map. Without this, a long-running indexer exposed
/// to the public internet accumulates one entry per unique IP forever — bots, scanners,
/// and one-time visitors leak memory unboundedly. We prune every `PRUNE_INTERVAL_MS`
/// (10 min) and drop any bucket idle for `PRUNE_IDLE_MS` (15 min — strictly larger than
/// the burst-refill window so an active client never gets evicted mid-flight).
///
/// `unref()` so the timer doesn't hold the process alive in tests / CLI entries that
/// import this module without a long-running server. The interval handle is kept on the
/// module scope intentionally — if a future caller wants to inspect or stop it (e.g.
/// the `__resetEventsEngineForTests`-style hook), exporting a stop fn is cheap.
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const PRUNE_IDLE_MS = 15 * 60 * 1000;
const pruneTimer: ReturnType<typeof setInterval> = setInterval(() => {
  pruneBuckets(bucketState, Date.now(), PRUNE_IDLE_MS);
}, PRUNE_INTERVAL_MS);
if (typeof pruneTimer === "object" && pruneTimer && "unref" in pruneTimer) {
  (pruneTimer as {unref: () => void}).unref();
}

/// Per-route cache instances. We could share one cache across all routes and namespace
/// keys by route prefix, but separate instances let each route keep its own TTL +
/// max-entries (the season cache holds 1 entry; the profile cache holds up to N).
const seasonCache = new LruTtlCache<unknown>({
  ttlMs: cacheCfg.seasonTtlMs,
  maxEntries: 1,
});
const tokensCache = new LruTtlCache<unknown>({
  ttlMs: cacheCfg.tokensTtlMs,
  maxEntries: 1,
});
const profileCache = new LruTtlCache<unknown>({
  ttlMs: cacheCfg.profileTtlMs,
  maxEntries: cacheCfg.maxEntries,
});
/// `/tokens/:address/history` is queryable on (token, from, to, interval), so the
/// cache holds many entries — one per distinct param tuple per token. Reuse the
/// profile-cache TTL knob since the data behind history changes on the same cadence
/// as the per-token snapshot writer (5 min ≈ HP_SNAPSHOT_INTERVAL_BLOCKS), but cap
/// the entries at the same multi-entry budget as profile.
const historyCache = new LruTtlCache<unknown>({
  ttlMs: cacheCfg.tokensTtlMs,
  maxEntries: cacheCfg.maxEntries,
});

export const seasonResponseCache: LruTtlCache<unknown> = seasonCache;
export const tokensResponseCache: LruTtlCache<unknown> = tokensCache;
export const profileResponseCache: LruTtlCache<unknown> = profileCache;
export const historyResponseCache: LruTtlCache<unknown> = historyCache;

// ============================================================ IP resolution

export function clientIpFromContext(c: MwContext): string {
  const xff = c.req.header("x-forwarded-for") ?? null;
  // The @hono/node-server binding hangs the underlying Node `IncomingMessage` off
  // `c.env.incoming` (or `c.env.server.incoming` for the server-bound variant). We poke
  // for it dynamically rather than importing `@hono/node-server/conninfo` because that's
  // a transitive ponder dep — pinning to its module path would couple us to a version we
  // don't directly declare. The shape is stable since hono v4.
  //
  // We read `socket.remoteAddress` (a string property — the *client's* IP) rather than
  // `socket.address()` (a method returning the *server's* local bind address). The
  // earlier draft used the latter, which collapsed every client to the server IP and
  // meant per-IP rate limiting became a single shared bucket whenever TRUST_PROXY was
  // off. Mirrors what hono's own `getConnInfo` does.
  const env = c.env as
    | {
        incoming?: {socket?: {remoteAddress?: string}};
        server?: {incoming?: {socket?: {remoteAddress?: string}}};
      }
    | undefined;
  let socket = "";
  try {
    const incoming = env?.server?.incoming ?? env?.incoming;
    const remote = incoming?.socket?.remoteAddress;
    if (typeof remote === "string") socket = remote;
  } catch {
    // Test environments that synthesize a fetch-style request without a Node socket
    // fall through to "unknown" via resolveClientIp's fallback.
  }
  return resolveClientIp(xff, socket, rateCfg.trustProxy);
}

// ============================================================ Rate-limit (GET)

export interface RateLimitDecision {
  allowed: boolean;
  /// Always set on the response (allowed or denied) per RFC draft. Useful even on a
  /// successful request so clients can self-throttle before hitting the cliff.
  remaining: number;
  /// Only meaningful on deny (always 0 on allow). Header value in seconds.
  retryAfterSec: number;
}

/// Consume one token from `ip`'s bucket and return the decision. Caller writes the
/// `RateLimit-Remaining` header on success and the 429 + headers on deny.
export function checkGetRateLimit(ip: string, nowMs: number = Date.now()): RateLimitDecision {
  const r = consumeBucket(bucketState, ip, rateCfg, nowMs);
  return {allowed: r.allowed, remaining: r.remaining, retryAfterSec: r.retryAfterSec};
}

/// Convenience wrapper for GET routes. Resolves IP, checks the bucket, writes headers.
/// Returns null if allowed (caller proceeds), or a 429 Response if denied.
export function applyGetRateLimit(c: MwContext): Response | null {
  const ip = clientIpFromContext(c);
  const decision = checkGetRateLimit(ip);
  // RateLimit-Remaining belongs on every response (RFC draft) so clients can pace
  // themselves before they hit 429.
  c.header("RateLimit-Remaining", String(decision.remaining));
  if (decision.allowed) return null;
  c.header("Retry-After", String(decision.retryAfterSec));
  return c.json(
    {error: "rate limit exceeded", retryAfterSec: decision.retryAfterSec},
    429,
  );
}

// ============================================================ Connection cap (/events)

export interface ConnectionDecision {
  allowed: boolean;
  current: number;
  retryAfterSec: number;
}

export function tryClaimEventsConn(ip: string): ConnectionDecision {
  return tryClaimConnection(connectionState, ip, rateCfg);
}

export function releaseEventsConn(ip: string): void {
  releaseConnection(connectionState, ip);
}

// ============================================================ Cache key helpers

/// Cache keys for the season + tokens routes. Today both are constants — there are no
/// query params that affect the response. Centralized so a future change (per-season
/// cohort views, etc.) lands in one place rather than scattered across route handlers.
export const SEASON_CACHE_KEY = "season:current";
export const TOKENS_CACHE_KEY = "tokens:current";

export function profileCacheKey(addr: `0x${string}`): string {
  return `profile:${addr.toLowerCase()}`;
}

/// Cache key for `/tokens/:address/history`. `from` / `to` / `interval` are part
/// of the key — different ranges/intervals share no entries. Param values are
/// passed through unchanged (the handler validates them later), but we replace
/// `undefined` with the literal sentinel `"-"` so the key is stable even when
/// the client omits a param entirely.
export function historyCacheKey(
  addr: `0x${string}`,
  params: {from?: string; to?: string; interval?: string},
): string {
  return `history:${addr.toLowerCase()}:${params.from ?? "-"}:${params.to ?? "-"}:${params.interval ?? "-"}`;
}

/// `?no-cache=1` (or `?nocache=1` — accept both, no convention has won) signals BYPASS.
/// Useful for ops sanity checks ("is the cache lying?") without restarting the process.
export function shouldBypassCache(c: MwContext): boolean {
  const url = new URL(c.req.url);
  const v = url.searchParams.get("no-cache") ?? url.searchParams.get("nocache");
  return v === "1" || v === "true";
}
