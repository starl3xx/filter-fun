/// Per-token coalescing scheduler — Epic 1.17b compute pathway.
///
/// HP recompute fires on every swap. A swap-bursty token (think 100 swaps in
/// a 30s window during a hot launch) would otherwise produce 100 hpSnapshot
/// rows with near-identical HP values and 100 SSE HP_UPDATED frames. The
/// pathway's contract (spec §6.8) is "the latest swap's HP is observable
/// within ≤5s, but bursts coalesce" — this module enforces it.
///
/// **Semantics.** `schedule(key, action)` records that an action is wanted
/// for `key`. If no action is currently in-flight or queued for that key,
/// the action runs after `windowMs` elapses. Subsequent calls within the
/// window replace the queued action with the latest one but DO NOT extend
/// the deadline — once the window opens, it closes deterministically. The
/// queued action runs against the *latest* recompute request, which captures
/// the cumulative state up to that moment (the action callback re-reads from
/// the DB rather than carrying stale data).
///
/// **Invariants tested.**
///   - 100 schedules in <windowMs → exactly 1 fire
///   - Fires happen monotonically; no duplicate fires for one window
///   - Different keys are independent (per-token isolation)
///   - Cancellation (clear) prevents the pending fire
///   - Errors thrown by the action are surfaced via the optional `onError`
///     hook so the scheduler keeps running for other keys

export interface CoalescingScheduler<TKey> {
  /// Request that `action` runs after `windowMs` elapses. If a window is
  /// already open for `key`, replaces the pending action and lets the
  /// existing deadline run. Returns the time-of-fire deadline (epoch ms)
  /// for testing/observability.
  schedule: (key: TKey, action: () => Promise<void> | void) => number;
  /// Cancel any pending action for `key`. No-op if none is queued.
  clear: (key: TKey) => void;
  /// Cancel all pending actions across all keys. Used on shutdown.
  clearAll: () => void;
  /// Snapshot of currently-pending keys. Test/diagnostic only.
  pendingKeys: () => TKey[];
}

export interface CoalescingOpts {
  /// Debounce window in milliseconds. The first `schedule(key, ...)` call
  /// opens a window; subsequent calls within it replace the pending action
  /// but do NOT extend the deadline.
  windowMs: number;
  /// Injected clock + timer for testing — defaults to wall-clock setTimeout.
  /// `setTimer` returns a handle that `clearTimer` consumes; matches the
  /// Node setTimeout/clearTimeout pair but works with fake timers in tests.
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  /// Called when an action throws. Defaults to console.error. The scheduler
  /// itself never throws — a single bad action mustn't poison other keys'
  /// pending fires.
  onError?: (key: unknown, err: unknown) => void;
}

interface PendingEntry {
  action: () => Promise<void> | void;
  handle: unknown;
  fireAtMs: number;
}

export function createCoalescingScheduler<TKey>(
  opts: CoalescingOpts,
): CoalescingScheduler<TKey> {
  const setT = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = opts.now ?? (() => Date.now());
  const onError = opts.onError ?? ((k, e) => console.error("[coalescing] action threw", k, e));

  const pending = new Map<TKey, PendingEntry>();

  const fire = (key: TKey) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    try {
      const r = entry.action();
      if (r && typeof (r as Promise<void>).then === "function") {
        (r as Promise<void>).catch((e) => onError(key, e));
      }
    } catch (e) {
      onError(key, e);
    }
  };

  return {
    schedule: (key, action) => {
      const existing = pending.get(key);
      if (existing) {
        // Window already open: replace the action but keep the existing
        // deadline. The behavior is "fire latest within window," not
        // "fire when activity quiets."
        existing.action = action;
        return existing.fireAtMs;
      }
      const fireAtMs = now() + opts.windowMs;
      const handle = setT(() => fire(key), opts.windowMs);
      pending.set(key, {action, handle, fireAtMs});
      return fireAtMs;
    },
    clear: (key) => {
      const entry = pending.get(key);
      if (!entry) return;
      clearT(entry.handle);
      pending.delete(key);
    },
    clearAll: () => {
      for (const entry of pending.values()) clearT(entry.handle);
      pending.clear();
    },
    pendingKeys: () => Array.from(pending.keys()),
  };
}

/// Latency SLA helper — wraps an async action, logs structured timing, and
/// emits a warning if the elapsed time exceeds `slaMs`. Pure logging side
/// effect; the action's result/throw is preserved.
export async function withLatencySla<T>(
  label: string,
  slaMs: number,
  action: () => Promise<T>,
  log: {
    info?: (msg: string, fields: Record<string, unknown>) => void;
    warn?: (msg: string, fields: Record<string, unknown>) => void;
  } = {info: console.log, warn: console.warn},
): Promise<T> {
  const startMs = Date.now();
  try {
    const out = await action();
    const elapsedMs = Date.now() - startMs;
    if (elapsedMs > slaMs) {
      (log.warn ?? console.warn)(`[hp-recompute] SLA breach`, {
        label,
        elapsedMs,
        slaMs,
      });
    } else if (log.info) {
      log.info(`[hp-recompute] ok`, {label, elapsedMs, slaMs});
    }
    return out;
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    (log.warn ?? console.warn)(`[hp-recompute] threw`, {label, elapsedMs, err: String(err)});
    throw err;
  }
}
