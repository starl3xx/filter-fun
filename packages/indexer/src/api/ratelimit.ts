/// Per-IP rate limiter for the GET endpoints + per-IP connection cap for `/events`.
///
/// Two distinct mechanisms, intentionally split:
///
///   - **Token bucket** for `/season`, `/tokens`, `/profile`. Each IP gets a bucket sized
///     to `RATELIMIT_BURST` that refills at `RATELIMIT_GET_PER_MIN / 60` tokens per second.
///     Lets a client burst up to `BURST` requests immediately and then settles into a
///     steady rate. Returns `Retry-After` (seconds) sized to "when the next token will be
///     available", which is the smoothest signal to give a polling leaderboard client.
///
///   - **Connection cap** for `/events` SSE. SSE is a long-lived connection, not a series
///     of requests — counting it against the per-request bucket would either let one
///     client open hundreds of streams or starve normal GETs. Instead we track concurrent
///     connections per IP and refuse new ones once the cap is hit; existing streams keep
///     flowing.
///
/// Both pieces are pure (operate on an explicit state object, take a clock fn) so vitest
/// can drive them without HTTP plumbing. The middleware adapter that resolves IPs from
/// Hono context lives in `index.ts`.

import {boolEnv, numEnv} from "./env.js";

export interface RateLimitConfig {
  /// Sustained rate, per IP, for GET endpoints. The bucket refills at this rate / 60s.
  getPerMin: number;
  /// Burst capacity per IP — the max tokens a bucket can hold. Allows clients to spike up
  /// to `burst` requests before throttling kicks in.
  burst: number;
  /// Concurrent SSE connections allowed per IP for `/events`.
  eventsConns: number;
  /// If true, trust `X-Forwarded-For` (leftmost hop) when resolving the client IP.
  /// Default false — only flip on when the indexer sits behind a known reverse proxy
  /// (e.g. Railway). Untrusted proxies + this flag = trivial spoofing.
  trustProxy: boolean;
}

export function loadRateLimitConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  return {
    getPerMin: numEnv(env, "RATELIMIT_GET_PER_MIN", 60),
    burst: numEnv(env, "RATELIMIT_BURST", 10),
    eventsConns: numEnv(env, "RATELIMIT_EVENTS_CONNS", 5),
    trustProxy: boolEnv(env, "TRUST_PROXY", false),
  };
}

// ============================================================ Token bucket

interface Bucket {
  /// Float — fractional tokens accrue between refills.
  tokens: number;
  /// Wall-clock ms at which `tokens` was last computed.
  lastRefillMs: number;
}

export interface TokenBucketState {
  buckets: Map<string, Bucket>;
}

export function makeBucketState(): TokenBucketState {
  return {buckets: new Map()};
}

export interface BucketResult {
  allowed: boolean;
  /// Tokens remaining after the consume attempt. Floored to integer for the
  /// `RateLimit-Remaining` header.
  remaining: number;
  /// Seconds the client should wait before retrying. 0 when allowed; >0 on deny.
  /// Computed as the time until the bucket has 1 token again.
  retryAfterSec: number;
}

/// Try to consume one token from `ip`'s bucket. Mutates `state` in place.
///
/// Capacity = `burst`; refill rate = `getPerMin / 60` tokens/sec. The math:
///   refilled = min(capacity, tokens + (now - lastRefill) * rate)
///   if refilled >= 1 → allow, tokens -= 1
///   else → deny, retryAfter = (1 - refilled) / rate
export function consumeBucket(
  state: TokenBucketState,
  ip: string,
  cfg: RateLimitConfig,
  nowMs: number,
): BucketResult {
  const capacity = cfg.burst;
  const ratePerMs = cfg.getPerMin / 60_000;
  let bucket = state.buckets.get(ip);
  if (!bucket) {
    // New client → start with a full bucket. Their first burst gets the full burst budget.
    bucket = {tokens: capacity, lastRefillMs: nowMs};
    state.buckets.set(ip, bucket);
  }
  const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
  const refilled = Math.min(capacity, bucket.tokens + elapsed * ratePerMs);
  bucket.lastRefillMs = nowMs;
  if (refilled >= 1) {
    bucket.tokens = refilled - 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterSec: 0,
    };
  }
  bucket.tokens = refilled;
  // Time until the bucket has 1 full token, in ms; ceil to whole seconds for the header
  // (SSE / fetch clients can't wait for sub-second granularity reliably).
  const msToOneToken = (1 - refilled) / ratePerMs;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSec: Math.max(1, Math.ceil(msToOneToken / 1000)),
  };
}

/// Drop bucket state for IPs that haven't been touched in `idleMs`. Optional helper for
/// long-running processes — without periodic GC the `buckets` map grows unbounded as the
/// IP space is explored. Genesis ships single-instance so this matters less than for a
/// fleet, but it's cheap insurance.
export function pruneBuckets(state: TokenBucketState, nowMs: number, idleMs: number): void {
  for (const [ip, bucket] of state.buckets) {
    if (nowMs - bucket.lastRefillMs > idleMs) state.buckets.delete(ip);
  }
}

// ============================================================ Connection cap (SSE)

export interface ConnectionState {
  countsByIp: Map<string, number>;
}

export function makeConnectionState(): ConnectionState {
  return {countsByIp: new Map()};
}

export interface ConnectionResult {
  allowed: boolean;
  /// Current count for this IP *after* the attempt. On allow: incremented. On deny:
  /// unchanged (caller never reaches the route handler).
  current: number;
  retryAfterSec: number;
}

/// Atomically claim a slot for `ip`. Caller MUST call `releaseConnection` when the SSE
/// stream closes — otherwise the count leaks and eventually all new connections are
/// refused. The route handler arranges this in a `finally` block so abnormal closes
/// (network drop, client refresh) still release.
export function tryClaimConnection(
  state: ConnectionState,
  ip: string,
  cfg: RateLimitConfig,
): ConnectionResult {
  const current = state.countsByIp.get(ip) ?? 0;
  if (current >= cfg.eventsConns) {
    // Retry-After for SSE is fuzzier — there's no guaranteed time at which a slot frees.
    // 30s is a reasonable hint that says "try again shortly, but not in a tight loop".
    return {allowed: false, current, retryAfterSec: 30};
  }
  state.countsByIp.set(ip, current + 1);
  return {allowed: true, current: current + 1, retryAfterSec: 0};
}

export function releaseConnection(state: ConnectionState, ip: string): void {
  const current = state.countsByIp.get(ip);
  if (!current) return; // already 0 — guard against double-release
  if (current <= 1) state.countsByIp.delete(ip);
  else state.countsByIp.set(ip, current - 1);
}

// ============================================================ IP resolution

/// Resolve the client IP from request headers + connection info.
///
/// `xff` is the raw `X-Forwarded-For` header (or null). `socketAddr` is the immediate
/// peer address. When `trustProxy` is true and `xff` is non-empty, returns the leftmost
/// (originating) hop from `xff` — that's the convention for direct-internet clients
/// reaching the indexer through a single trusted reverse proxy.
///
/// When `trustProxy` is false, `xff` is *ignored* — important: a client can otherwise
/// send `X-Forwarded-For: <victim>` and burn another IP's rate-limit budget. The default
/// is intentionally restrictive.
///
/// `socketAddr` may be empty in test environments; we fall back to the literal string
/// `"unknown"` which still partitions per-process tests but makes the missing data
/// observable in production logs (any "unknown" IP rate is a deployment misconfig).
export function resolveClientIp(
  xff: string | null,
  socketAddr: string,
  trustProxy: boolean,
): string {
  if (trustProxy && xff && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  return socketAddr || "unknown";
}

