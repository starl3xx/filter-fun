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

export interface ApiMiddlewareConfig {
  rate: RateLimitConfig;
  cache: CacheConfig;
}

export function getMiddlewareConfig(): ApiMiddlewareConfig {
  return {rate: rateCfg, cache: cacheCfg};
}

export const seasonResponseCache: LruTtlCache<unknown> = seasonCache;
export const tokensResponseCache: LruTtlCache<unknown> = tokensCache;
export const profileResponseCache: LruTtlCache<unknown> = profileCache;

// ============================================================ IP resolution

export function clientIpFromContext(c: MwContext): string {
  const xff = c.req.header("x-forwarded-for") ?? null;
  // The @hono/node-server binding hangs the underlying Node `IncomingMessage` off
  // `c.env.incoming` (or `c.env.server.incoming` for the server-bound variant). We poke
  // for it dynamically rather than importing `@hono/node-server/conninfo` because that's
  // a transitive ponder dep — pinning to its module path would couple us to a version we
  // don't directly declare. The shape is stable since hono v4.
  const env = c.env as
    | {
        incoming?: {socket?: {address?: () => {address?: string}}};
        server?: {incoming?: {socket?: {address?: () => {address?: string}}}};
      }
    | undefined;
  let socket = "";
  try {
    const incoming = env?.server?.incoming ?? env?.incoming;
    const a = incoming?.socket?.address?.();
    if (a && typeof a === "object" && "address" in a && typeof a.address === "string") {
      socket = a.address;
    }
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

/// `?no-cache=1` (or `?nocache=1` — accept both, no convention has won) signals BYPASS.
/// Useful for ops sanity checks ("is the cache lying?") without restarting the process.
export function shouldBypassCache(c: MwContext): boolean {
  const url = new URL(c.req.url);
  const v = url.searchParams.get("no-cache") ?? url.searchParams.get("nocache");
  return v === "1" || v === "true";
}
