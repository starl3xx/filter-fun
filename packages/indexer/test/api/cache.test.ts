/// LRU+TTL cache + `cached()` wrapper tests.
///
/// Time is driven by an injected `now()` so every TTL/expiry assertion is deterministic.
/// We never call `setTimeout` or `Date.now` here — vitest fake timers are heavier than
/// needed and obscure the actual wall-clock semantics.

import {beforeEach, describe, expect, it, vi} from "vitest";

import {cached, loadCacheConfigFromEnv, LruTtlCache} from "../../src/api/cache.js";

describe("LruTtlCache", () => {
  let now = 0;
  const clock = () => now;
  beforeEach(() => {
    now = 1_000_000;
  });

  it("get returns null for missing keys", () => {
    const c = new LruTtlCache<string>({ttlMs: 1_000, maxEntries: 10, now: clock});
    expect(c.get("missing")).toBeNull();
  });

  it("set then get within TTL returns the same value", () => {
    const c = new LruTtlCache<{n: number}>({ttlMs: 1_000, maxEntries: 10, now: clock});
    const value = {n: 42};
    c.set("k", value);
    now += 500;
    expect(c.get("k")).toBe(value); // identity preserved
  });

  it("entries expire after TTL — get returns null and the entry is dropped", () => {
    const c = new LruTtlCache<string>({ttlMs: 1_000, maxEntries: 10, now: clock});
    c.set("k", "v");
    expect(c.size()).toBe(1);
    now += 1_001; // past TTL
    expect(c.get("k")).toBeNull();
    expect(c.size()).toBe(0); // lazy eviction on access
  });

  it("set on an existing key resets the TTL clock", () => {
    const c = new LruTtlCache<string>({ttlMs: 1_000, maxEntries: 10, now: clock});
    c.set("k", "old");
    now += 800;
    c.set("k", "new");
    now += 800; // 1600ms after first set, but only 800ms after second set
    expect(c.get("k")).toBe("new");
  });

  it("LRU eviction drops the oldest unused entry when over maxEntries", () => {
    const c = new LruTtlCache<string>({ttlMs: 60_000, maxEntries: 3, now: clock});
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3");
    expect(c.size()).toBe(3);
    // Touch "a" so "b" becomes LRU.
    expect(c.get("a")).toBe("1");
    c.set("d", "4"); // overflow — should evict "b"
    expect(c.size()).toBe(3);
    expect(c.get("a")).toBe("1");
    expect(c.get("b")).toBeNull();
    expect(c.get("c")).toBe("3");
    expect(c.get("d")).toBe("4");
  });

  it("delete removes a key without touching others", () => {
    const c = new LruTtlCache<string>({ttlMs: 60_000, maxEntries: 10, now: clock});
    c.set("a", "1");
    c.set("b", "2");
    c.delete("a");
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).toBe("2");
    expect(c.size()).toBe(1);
  });

  it("rejects invalid construction params", () => {
    expect(() => new LruTtlCache({ttlMs: 0, maxEntries: 10})).toThrow();
    expect(() => new LruTtlCache({ttlMs: 100, maxEntries: 0})).toThrow();
  });
});

describe("cached() wrapper", () => {
  let now = 1_000_000;
  const clock = () => now;

  it("MISS on first call, HIT on second within TTL — bodies are byte-for-byte identical", async () => {
    const cache = new LruTtlCache<unknown>({ttlMs: 1_000, maxEntries: 10, now: clock});
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return {value: "ok", n: 42};
    };
    const r1 = await cached(cache, "k", compute);
    expect(r1.status).toBe("MISS");
    expect(computeCalls).toBe(1);

    now += 500;
    const r2 = await cached(cache, "k", compute);
    expect(r2.status).toBe("HIT");
    expect(computeCalls).toBe(1); // not re-invoked
    // Byte-for-byte: serializing both yields the same string. (Identity also holds, but
    // serialization is the contract clients care about.)
    expect(JSON.stringify(r2.value)).toBe(JSON.stringify(r1.value));
  });

  it("MISS again after TTL expiry — cache recomputes the body", async () => {
    const cache = new LruTtlCache<unknown>({ttlMs: 1_000, maxEntries: 10, now: clock});
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return {n: computeCalls};
    };
    const r1 = await cached(cache, "k", compute);
    expect(r1.status).toBe("MISS");
    now += 1_500; // past TTL
    const r2 = await cached(cache, "k", compute);
    expect(r2.status).toBe("MISS");
    expect((r2.value as {n: number}).n).toBe(2);
  });

  it("BYPASS short-circuits even when a fresh entry exists", async () => {
    const cache = new LruTtlCache<unknown>({ttlMs: 60_000, maxEntries: 10, now: clock});
    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return {n: computeCalls};
    };
    await cached(cache, "k", compute); // seeds MISS
    const r = await cached(cache, "k", compute, {bypass: true});
    expect(r.status).toBe("BYPASS");
    expect(computeCalls).toBe(2);
  });

  it("two distinct cache keys do not collide — different addresses get different bodies", async () => {
    // Pins the /profile cache-key isolation: queries for two wallets must land on
    // independent entries even if they share a prefix.
    const cache = new LruTtlCache<unknown>({ttlMs: 60_000, maxEntries: 10, now: clock});
    const ra = await cached(cache, "profile:0xaaaa", async () => ({addr: "a"}));
    const rb = await cached(cache, "profile:0xbbbb", async () => ({addr: "b"}));
    expect((ra.value as {addr: string}).addr).toBe("a");
    expect((rb.value as {addr: string}).addr).toBe("b");
    // Re-reading both still yields HIT with the right body.
    const ra2 = await cached(cache, "profile:0xaaaa", async () => ({addr: "WRONG"}));
    const rb2 = await cached(cache, "profile:0xbbbb", async () => ({addr: "WRONG"}));
    expect(ra2.status).toBe("HIT");
    expect((ra2.value as {addr: string}).addr).toBe("a");
    expect(rb2.status).toBe("HIT");
    expect((rb2.value as {addr: string}).addr).toBe("b");
  });
});

describe("loadCacheConfigFromEnv", () => {
  it("uses Epic 1.3 part 3/3 defaults when env is empty", () => {
    const cfg = loadCacheConfigFromEnv({});
    expect(cfg.seasonTtlMs).toBe(3_000);
    expect(cfg.tokensTtlMs).toBe(5_000);
    expect(cfg.profileTtlMs).toBe(30_000);
    expect(cfg.maxEntries).toBe(10_000);
  });

  it("env overrides", () => {
    const cfg = loadCacheConfigFromEnv({
      CACHE_TTL_SEASON_MS: "100",
      CACHE_TTL_TOKENS_MS: "200",
      CACHE_TTL_PROFILE_MS: "300",
      CACHE_MAX_ENTRIES: "5",
    });
    expect(cfg).toEqual({
      seasonTtlMs: 100,
      tokensTtlMs: 200,
      profileTtlMs: 300,
      maxEntries: 5,
    });
  });

  it("rejects non-positive env values", () => {
    expect(() => loadCacheConfigFromEnv({CACHE_TTL_SEASON_MS: "0"})).toThrow();
    expect(() => loadCacheConfigFromEnv({CACHE_MAX_ENTRIES: "-1"})).toThrow();
    expect(() => loadCacheConfigFromEnv({CACHE_TTL_TOKENS_MS: "abc"})).toThrow();
  });
});

describe("historyCacheKey", () => {
  it("includes from/to/interval — different windows are distinct cache entries", async () => {
    const {historyCacheKey} = await import("../../src/api/middleware.js");
    const a = addr(0xa);
    expect(historyCacheKey(a, {from: "1", to: "2", interval: "300"})).not.toBe(
      historyCacheKey(a, {from: "1", to: "2", interval: "60"}),
    );
    expect(historyCacheKey(a, {from: "1", to: "2", interval: "300"})).not.toBe(
      historyCacheKey(a, {from: "1", to: "3", interval: "300"})  ,
    );
  });

  it("collapses missing params to a stable sentinel — two omit-all calls share the cache", async () => {
    const {historyCacheKey} = await import("../../src/api/middleware.js");
    const a = addr(0xb);
    expect(historyCacheKey(a, {})).toBe(historyCacheKey(a, {}));
  });
});

/// Audit finding C-3 (Phase 1 audit 2026-05-01) — `/tokens/:address/history`
/// cache was wired to `cacheCfg.tokensTtlMs` (5s default) instead of
/// `cacheCfg.profileTtlMs` (30s default, intent ~5min per HP_SNAPSHOT_INTERVAL_BLOCKS).
/// The bug was masked by the cache's opacity at the type level and by the absence of
/// any test asserting the wired TTL. This block locks BOTH the per-route wiring AND
/// the relationship "history TTL == profile TTL", so future env-config refactors
/// can't silently regress.
///
/// Pre-fix this test FAILS — historyResponseCache.ttlMs equals tokensResponseCache.ttlMs
/// (both 5_000ms) and is NOT equal to profileResponseCache.ttlMs (30_000ms).
/// Post-fix it PASSES — historyResponseCache.ttlMs equals profileResponseCache.ttlMs.
describe("response-cache TTL wiring (audit finding C-3)", () => {
  it("history cache reuses the profile TTL knob, not the tokens TTL knob", async () => {
    const {historyResponseCache, profileResponseCache, tokensResponseCache} = await import(
      "../../src/api/middleware.js"
    );
    expect(historyResponseCache.ttlMs).toBe(profileResponseCache.ttlMs);
    // Belt-and-braces: explicitly assert the bug-shape (history === tokens) does NOT hold.
    // If a future refactor flips both profileTtlMs and tokensTtlMs to the same default the
    // first assertion would silently pass; this second assertion only holds if the two
    // knobs *exist as distinct values at runtime* (which is the env contract).
    expect(historyResponseCache.ttlMs).not.toBe(tokensResponseCache.ttlMs);
  });
});

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

// Silence the vi import warning when no spies are used in the file.
vi.fn();
