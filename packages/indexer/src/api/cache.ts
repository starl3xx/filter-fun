/// In-process LRU+TTL cache for `/season`, `/tokens`, `/profile`.
///
/// Genesis ships single-instance, so we don't need redis. The `Cache` interface is
/// intentionally narrow (`get` / `set` / `delete` / `size`) so a redis-backed
/// implementation can drop in later without touching call sites — replace `LruTtlCache`
/// with `RedisCache` and wire the same interface.
///
/// Eviction policy:
///   - **TTL** — stored entries expire after `ttlMs`. Expired entries are evicted on
///     read (lazy) and not surfaced to callers.
///   - **LRU** — when `size() > maxEntries`, the least-recently-used entry is dropped.
///     "Used" means most-recently `get()` or `set()`; we re-insert into the underlying
///     `Map` on every access so iteration order tracks recency. JavaScript `Map`
///     preserves insertion order, which gives us O(1) LRU bookkeeping without an
///     extra doubly-linked list.
///
/// The cache is *value-typed*, not response-typed — we store the handler's return value,
/// not the serialized JSON. Re-serialization on hit costs ~tens of microseconds and avoids
/// stale-Content-Length / encoding pitfalls vs caching the wire bytes. Tests assert
/// byte-for-byte equivalence by JSON.stringify-ing both the original miss body and the
/// hit body — that's a sufficient invariant.

import {numEnv} from "./env.js";

export interface Cache<V> {
  /// Returns the cached value if present and unexpired, else `null`.
  get(key: string): V | null;
  /// Stores `value` under `key`. Resets the TTL clock and marks the entry as MRU.
  set(key: string, value: V): void;
  /// Removes `key` if present.
  delete(key: string): void;
  /// Current entry count (excludes lazily-expired entries that haven't been accessed yet).
  size(): number;
}

export interface LruTtlOptions {
  /// Time-to-live in ms. Required — we don't ship an "infinite" cache; every cacheable
  /// route declares its own staleness budget.
  ttlMs: number;
  /// LRU cap. When exceeded, the oldest-accessed entry is evicted.
  maxEntries: number;
  /// Override for tests. Defaults to `() => Date.now()`.
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruTtlCache<V> implements Cache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: LruTtlOptions) {
    if (opts.ttlMs <= 0) throw new Error("LruTtlCache: ttlMs must be > 0");
    if (opts.maxEntries <= 0) throw new Error("LruTtlCache: maxEntries must be > 0");
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? (() => Date.now());
  }

  get(key: string): V | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    // Bump recency: delete + re-insert moves this entry to the end of the iteration order
    // so it's no longer a candidate for the next eviction.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) this.store.delete(key); // re-insert to bump recency
    this.store.set(key, {value, expiresAt: this.now() + this.ttlMs});
    if (this.store.size > this.maxEntries) {
      // Evict the LRU entry — the first key in iteration order.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  size(): number {
    return this.store.size;
  }
}

/// Wraps a handler with read-through cache semantics.
///
/// `keyFn` produces the cache key from the handler's input — for `/season` it's a constant
/// string; for `/profile/:address` it's the normalized address. `bypass` short-circuits the
/// cache and forces a fresh compute, returning `MISS` (not `BYPASS`) is wrong here — we
/// surface `BYPASS` so clients can tell "you asked us to skip cache" apart from "we missed
/// and recomputed". Returning the same shape as a miss keeps consumers from branching on
/// status; only the header differs.
export type CacheStatus = "HIT" | "MISS" | "BYPASS";

export interface CachedResult<T> {
  value: T;
  status: CacheStatus;
}

export async function cached<O>(
  /// Caches are typed `Cache<unknown>` at the singleton boundary because the same module
  /// stores values of different shapes per route. Each call site narrows via the generic
  /// `O` of `compute` — the cache itself is opaque storage.
  cache: Cache<unknown>,
  key: string,
  compute: () => Promise<O>,
  opts?: {bypass?: boolean},
): Promise<CachedResult<O>> {
  if (opts?.bypass) {
    const value = await compute();
    return {value, status: "BYPASS"};
  }
  const hit = cache.get(key);
  if (hit !== null) return {value: hit as O, status: "HIT"};
  const value = await compute();
  cache.set(key, value);
  return {value, status: "MISS"};
}

/// Loads cache TTLs + max-entries from environment, with the defaults specified in the
/// Epic 1.3 part 3/3 brief. Mirrors the pattern in `events/config.ts` so all configurable
/// knobs land in `EVENTS_*` / `CACHE_*` / `RATELIMIT_*` namespaces.
export interface CacheConfig {
  seasonTtlMs: number;
  tokensTtlMs: number;
  profileTtlMs: number;
  maxEntries: number;
}

export function loadCacheConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  return {
    seasonTtlMs: numEnv(env, "CACHE_TTL_SEASON_MS", 3_000),
    tokensTtlMs: numEnv(env, "CACHE_TTL_TOKENS_MS", 5_000),
    profileTtlMs: numEnv(env, "CACHE_TTL_PROFILE_MS", 30_000),
    maxEntries: numEnv(env, "CACHE_MAX_ENTRIES", 10_000),
  };
}
