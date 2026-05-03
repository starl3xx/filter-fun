/// Latency-SLA wrapper — Epic 1.17b compute pathway.
///
/// `withLatencySla` wraps an async action, logs its elapsed time, and emits
/// a structured warning if the elapsed time exceeds `slaMs`. Used by the
/// swap and holder-balance handlers to surface "HP recompute is taking too
/// long" symptoms before they become user-visible (>5s leaderboard staleness).
///
/// **Coalescing.** Per-token HP-recompute coalescing is implemented in SQL
/// inside `recomputeAndStampHp` (`hpRecomputeWriter.ts`) — a row is skipped
/// if a recent row exists for `(token, ts ≥ blockTimestamp - 1s)`. A
/// timer-based debounce scheduler is intentionally *not* used: Drizzle's
/// `context.db` is transaction-scoped and would be invalid by the time a
/// deferred timer fires. The SQL pre-check handles both historical replay
/// (block-time bursts collapse via the unique-key on `${token}:${ts}`) and
/// real-time mode (where block-time approximates wall-clock).

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
