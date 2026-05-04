/// Per-IP rate limiter tests — token bucket + connection cap + IP resolution.

import {beforeEach, describe, expect, it} from "vitest";

import {clientIpFromContext, type MwContext} from "../../src/api/middleware.js";
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
} from "../../src/api/ratelimit.js";

function defaultCfg(over: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    getPerMin: 60,
    burst: 10,
    eventsConns: 5,
    trustProxy: false,
    ...over,
  };
}

describe("token bucket", () => {
  let now = 0;
  beforeEach(() => {
    now = 1_700_000_000_000;
  });

  it("first request from a new IP allows the full burst budget", () => {
    const state = makeBucketState();
    const cfg = defaultCfg();
    const r = consumeBucket(state, "1.1.1.1", cfg, now);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9); // 10-token burst, consumed 1
  });

  it("60 GETs/min, burst=10 — 11th request inside 1s starts being throttled", () => {
    // Refill rate at 60/min = 1 token/sec. Burst is 10. So 10 requests fire instantly,
    // and the 11th finds the bucket nearly empty (only ~0.001s of refill happened).
    const state = makeBucketState();
    const cfg = defaultCfg({getPerMin: 60, burst: 10});
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 11; i++) {
      const r = consumeBucket(state, "1.1.1.1", cfg, now);
      if (r.allowed) allowed++;
      else denied++;
      now += 1; // 1ms between requests — well below refill rate
    }
    expect(allowed).toBe(10);
    expect(denied).toBe(1);
  });

  it("after Retry-After elapses, request succeeds again", () => {
    const state = makeBucketState();
    const cfg = defaultCfg({getPerMin: 60, burst: 10});
    // Drain the bucket.
    for (let i = 0; i < 10; i++) consumeBucket(state, "1.1.1.1", cfg, now);
    const denied = consumeBucket(state, "1.1.1.1", cfg, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    // Wait the retry-after window.
    now += denied.retryAfterSec * 1_000;
    const allowed = consumeBucket(state, "1.1.1.1", cfg, now);
    expect(allowed.allowed).toBe(true);
  });

  it("different IPs have independent buckets", () => {
    const state = makeBucketState();
    const cfg = defaultCfg({getPerMin: 60, burst: 2});
    // Drain IP A.
    consumeBucket(state, "1.1.1.1", cfg, now);
    consumeBucket(state, "1.1.1.1", cfg, now);
    const aDenied = consumeBucket(state, "1.1.1.1", cfg, now);
    expect(aDenied.allowed).toBe(false);
    // IP B still has its full bucket.
    const bAllowed = consumeBucket(state, "2.2.2.2", cfg, now);
    expect(bAllowed.allowed).toBe(true);
    expect(bAllowed.remaining).toBe(1); // burst=2, consumed 1
  });

  it("Retry-After is capped to whole seconds and never zero on deny", () => {
    // Pin the integer-ceiling rule — clients can't reliably wait sub-second windows, and a
    // 0 in Retry-After is a footgun (some libraries treat 0 as "retry immediately").
    const state = makeBucketState();
    const cfg = defaultCfg({getPerMin: 600, burst: 1}); // 10 tokens/sec refill
    consumeBucket(state, "1.1.1.1", cfg, now); // drain
    const denied = consumeBucket(state, "1.1.1.1", cfg, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(denied.retryAfterSec)).toBe(true);
  });

  it("pruneBuckets drops idle IPs", () => {
    const state = makeBucketState();
    const cfg = defaultCfg();
    consumeBucket(state, "stale", cfg, now); // last touched at now
    consumeBucket(state, "fresh", cfg, now + 50_000); // last touched 10s before prune
    pruneBuckets(state, now + 60_000, 30_000); // idle threshold 30s
    expect(state.buckets.has("stale")).toBe(false);
    expect(state.buckets.has("fresh")).toBe(true);
  });
});

describe("connection cap (/events)", () => {
  it("allows up to N concurrent connections, denies the (N+1)th", () => {
    const state = makeConnectionState();
    const cfg = defaultCfg({eventsConns: 5});
    for (let i = 0; i < 5; i++) {
      const r = tryClaimConnection(state, "1.1.1.1", cfg);
      expect(r.allowed).toBe(true);
    }
    const denied = tryClaimConnection(state, "1.1.1.1", cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    // Existing 5 are not affected — cap is on *new* connections.
    expect(state.countsByIp.get("1.1.1.1")).toBe(5);
  });

  it("releaseConnection frees a slot — a new connection from same IP is then allowed", () => {
    const state = makeConnectionState();
    const cfg = defaultCfg({eventsConns: 2});
    tryClaimConnection(state, "1.1.1.1", cfg);
    tryClaimConnection(state, "1.1.1.1", cfg);
    expect(tryClaimConnection(state, "1.1.1.1", cfg).allowed).toBe(false);
    releaseConnection(state, "1.1.1.1");
    expect(tryClaimConnection(state, "1.1.1.1", cfg).allowed).toBe(true);
  });

  it("double-release is a safe no-op (guards against finally-block double-fire)", () => {
    const state = makeConnectionState();
    const cfg = defaultCfg({eventsConns: 2});
    tryClaimConnection(state, "1.1.1.1", cfg);
    releaseConnection(state, "1.1.1.1");
    releaseConnection(state, "1.1.1.1"); // shouldn't crash, shouldn't go negative
    expect(state.countsByIp.has("1.1.1.1")).toBe(false);
  });

  it("different IPs have independent counts", () => {
    const state = makeConnectionState();
    const cfg = defaultCfg({eventsConns: 1});
    expect(tryClaimConnection(state, "1.1.1.1", cfg).allowed).toBe(true);
    expect(tryClaimConnection(state, "1.1.1.1", cfg).allowed).toBe(false);
    expect(tryClaimConnection(state, "2.2.2.2", cfg).allowed).toBe(true);
  });
});

describe("resolveClientIp", () => {
  it("ignores X-Forwarded-For when trustProxy is false", () => {
    expect(resolveClientIp("9.9.9.9", "1.1.1.1", false)).toBe("1.1.1.1");
  });

  it("returns the leftmost X-Forwarded-For hop when trustProxy is true", () => {
    expect(resolveClientIp("9.9.9.9, 10.0.0.1", "1.1.1.1", true)).toBe("9.9.9.9");
  });

  it("falls through to socket addr when X-Forwarded-For is missing or empty", () => {
    expect(resolveClientIp(null, "1.1.1.1", true)).toBe("1.1.1.1");
    expect(resolveClientIp("", "1.1.1.1", true)).toBe("1.1.1.1");
  });

  it("trims whitespace from X-Forwarded-For entries", () => {
    expect(resolveClientIp("  9.9.9.9  , 10.0.0.1", "1.1.1.1", true)).toBe("9.9.9.9");
  });

  it("falls back to 'unknown' when both XFF and socket are empty", () => {
    expect(resolveClientIp(null, "", false)).toBe("unknown");
  });
});

describe("clientIpFromContext", () => {
  /// Build a fake MwContext with the Node-server-style `env.incoming.socket` shape that
  /// `clientIpFromContext` pokes at. The shape mirrors what `@hono/node-server` exposes.
  function fakeCtx(opts: {
    xff?: string;
    serverIncoming?: {socket?: {remoteAddress?: string}};
    plainIncoming?: {socket?: {remoteAddress?: string}};
  }): MwContext {
    return {
      req: {
        url: "http://localhost/",
        method: "GET",
        path: "/",
        header: (name) => (name.toLowerCase() === "x-forwarded-for" ? opts.xff : undefined),
      },
      header: () => {},
      json: () => new Response(),
      env: {
        ...(opts.serverIncoming ? {server: {incoming: opts.serverIncoming}} : {}),
        ...(opts.plainIncoming ? {incoming: opts.plainIncoming} : {}),
      },
    };
  }

  it("regression: reads socket.remoteAddress (client IP) not socket.address() (server bind)", () => {
    // Bug fix from bugbot review on ba6b868: previous code called `socket.address()`,
    // which returns the *server's* local bind address, collapsing every client to a
    // single bucket whenever TRUST_PROXY=false. The correct property is `remoteAddress`.
    const ip = clientIpFromContext(
      fakeCtx({plainIncoming: {socket: {remoteAddress: "203.0.113.42"}}}),
    );
    expect(ip).toBe("203.0.113.42");
  });

  it("falls back to env.incoming when env.server.incoming is missing", () => {
    const ip = clientIpFromContext(
      fakeCtx({plainIncoming: {socket: {remoteAddress: "198.51.100.7"}}}),
    );
    expect(ip).toBe("198.51.100.7");
  });

  it("prefers env.server.incoming over env.incoming when both are present", () => {
    const ip = clientIpFromContext(
      fakeCtx({
        serverIncoming: {socket: {remoteAddress: "10.0.0.1"}},
        plainIncoming: {socket: {remoteAddress: "192.168.1.1"}},
      }),
    );
    expect(ip).toBe("10.0.0.1");
  });

  it("falls back to 'unknown' when no socket info is reachable", () => {
    const ip = clientIpFromContext(fakeCtx({}));
    expect(ip).toBe("unknown");
  });
});

describe("loadRateLimitConfigFromEnv", () => {
  it("uses spec defaults when env is empty", () => {
    const cfg = loadRateLimitConfigFromEnv({});
    expect(cfg.getPerMin).toBe(60);
    expect(cfg.burst).toBe(10);
    expect(cfg.eventsConns).toBe(5);
    expect(cfg.trustProxy).toBe(false);
  });

  it("env overrides — TRUST_PROXY accepts true/1/yes", () => {
    expect(loadRateLimitConfigFromEnv({TRUST_PROXY: "true"}).trustProxy).toBe(true);
    expect(loadRateLimitConfigFromEnv({TRUST_PROXY: "1"}).trustProxy).toBe(true);
    expect(loadRateLimitConfigFromEnv({TRUST_PROXY: "yes"}).trustProxy).toBe(true);
    expect(loadRateLimitConfigFromEnv({TRUST_PROXY: "false"}).trustProxy).toBe(false);
  });

  it("env overrides — numeric knobs", () => {
    const cfg = loadRateLimitConfigFromEnv({
      RATELIMIT_GET_PER_MIN: "120",
      RATELIMIT_BURST: "20",
      RATELIMIT_EVENTS_CONNS: "10",
    });
    expect(cfg).toMatchObject({getPerMin: 120, burst: 20, eventsConns: 10});
  });

  it("rejects invalid env values", () => {
    expect(() => loadRateLimitConfigFromEnv({TRUST_PROXY: "maybe"})).toThrow();
    expect(() => loadRateLimitConfigFromEnv({RATELIMIT_GET_PER_MIN: "0"})).toThrow();
    expect(() => loadRateLimitConfigFromEnv({RATELIMIT_BURST: "-1"})).toThrow();
  });
});
