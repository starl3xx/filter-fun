/// Configuration for the `/events` stream — detection thresholds, pipeline windows,
/// and per-connection backpressure caps.
///
/// Exposed via env vars so testnet rehearsals can dial up sensitivity without a redeploy
/// (e.g. shorten the dedupe window to make every signal land for a recorded demo, or raise
/// the HP-spike threshold once the noise floor is understood). Each env var has a sane
/// default so the stream works out of the box.
///
/// Test code constructs a `EventsConfig` directly via `withDefaults` rather than reading
/// the environment, keeping vitest deterministic.

export interface EventsConfig {
  /// Detector tick cadence in milliseconds. The tick reads a fresh snapshot from the DB,
  /// diffs it against the previous tick, and pushes diffs through the pipeline.
  tickMs: number;

  /// Dedupe window: a (token, type) pair seen within this many ms is collapsed to one event.
  dedupeWindowMs: number;

  /// Per-token throttle: at most `throttlePerTokenMax` events per token per
  /// `throttleWindowMs`. A volatile token can't dominate the feed.
  throttleWindowMs: number;
  throttlePerTokenMax: number;

  /// HP-spike threshold (in the 0–100 wire-format HP scale). Drives the HP_SPIKE event.
  hpSpikeThreshold: number;

  /// Minimum integer change in rank required to fire a RANK_CHANGED event.
  rankChangeMin: number;

  /// Volume-spike: ratio of current-window WETH volume to trailing-baseline volume that
  /// triggers a VOLUME_SPIKE. Plus a minimum absolute window volume so dust-level noise
  /// can't trigger huge ratios.
  volumeSpikeRatio: number;
  volumeSpikeMinWethWei: bigint;

  /// Large-trade threshold (raw WETH wei). A single inferred trade above this fires
  /// LARGE_TRADE.
  largeTradeWethWei: bigint;
  /// Total trading fee in BPS (spec §9 — 200 BPS = 2.0%). Used to infer trade size from
  /// indexed fee accruals: `tradeWeth = totalFeeWeth * 10_000 / tradeFeeBps`.
  tradeFeeBps: number;

  /// Per-connection queue cap. When the queue is full, evict oldest LOW first, then MEDIUM,
  /// never HIGH. Connections that fall too far behind get truncated rather than blocking
  /// the broadcast loop.
  perConnQueueMax: number;

  /// SSE heartbeat — emit a comment line every `heartbeatMs` so reverse-proxy idle timeouts
  /// don't drop a quiet stream. SSE clients auto-reconnect, but a heartbeat keeps the
  /// connection warm in the first place.
  heartbeatMs: number;

  /// Filter-moment suppression window. After a FILTER_FIRED event, all non-filter LOW/MEDIUM
  /// events are dropped for this many ms (spec §36.1.4: "during filter moments, suppress
  /// all but filter-related events").
  filterMomentWindowMs: number;

  /// FILTER_COUNTDOWN trigger: a HIGH-priority "🔻 Filter in Nm" event fires the first tick
  /// after `(nextCutSec - takenAtSec) <= filterCountdownThresholdSec`. Default = 600s
  /// (10 min) per spec §20 examples.
  filterCountdownThresholdSec: number;
}

const DEFAULTS: EventsConfig = {
  tickMs: 5_000,
  dedupeWindowMs: 30_000,
  throttleWindowMs: 30_000,
  throttlePerTokenMax: 3,
  hpSpikeThreshold: 10,
  rankChangeMin: 1,
  volumeSpikeRatio: 2.5,
  volumeSpikeMinWethWei: 100_000_000_000_000_000n, // 0.1 WETH
  largeTradeWethWei: 500_000_000_000_000_000n, // 0.5 WETH
  tradeFeeBps: 200,
  perConnQueueMax: 200,
  heartbeatMs: 15_000,
  filterMomentWindowMs: 60_000,
  filterCountdownThresholdSec: 600,
};

/// Returns a config merged from `DEFAULTS` and the partial overrides. Used by both the
/// env-driven `loadConfigFromEnv` and tests that want to pin specific knobs.
export function withDefaults(overrides: Partial<EventsConfig> = {}): EventsConfig {
  return {...DEFAULTS, ...overrides};
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EventsConfig {
  return withDefaults({
    tickMs: parseIntEnv(env.EVENTS_TICK_MS, DEFAULTS.tickMs),
    dedupeWindowMs: parseIntEnv(env.EVENTS_DEDUPE_WINDOW_MS, DEFAULTS.dedupeWindowMs),
    throttleWindowMs: parseIntEnv(env.EVENTS_THROTTLE_WINDOW_MS, DEFAULTS.throttleWindowMs),
    throttlePerTokenMax: parseIntEnv(env.EVENTS_THROTTLE_PER_TOKEN, DEFAULTS.throttlePerTokenMax),
    hpSpikeThreshold: parseFloatEnv(env.EVENTS_HP_SPIKE_THRESHOLD, DEFAULTS.hpSpikeThreshold),
    rankChangeMin: parseIntEnv(env.EVENTS_RANK_CHANGE_MIN, DEFAULTS.rankChangeMin),
    volumeSpikeRatio: parseFloatEnv(env.EVENTS_VOLUME_SPIKE_RATIO, DEFAULTS.volumeSpikeRatio),
    volumeSpikeMinWethWei: parseWeiEnv(env.EVENTS_VOLUME_SPIKE_MIN_WETH, DEFAULTS.volumeSpikeMinWethWei),
    largeTradeWethWei: parseWeiEnv(env.EVENTS_LARGE_TRADE_WETH, DEFAULTS.largeTradeWethWei),
    tradeFeeBps: parseIntEnv(env.EVENTS_TRADE_FEE_BPS, DEFAULTS.tradeFeeBps),
    perConnQueueMax: parseIntEnv(env.EVENTS_PER_CONN_QUEUE_MAX, DEFAULTS.perConnQueueMax),
    heartbeatMs: parseIntEnv(env.EVENTS_HEARTBEAT_MS, DEFAULTS.heartbeatMs),
    filterMomentWindowMs: parseIntEnv(
      env.EVENTS_FILTER_MOMENT_WINDOW_MS,
      DEFAULTS.filterMomentWindowMs,
    ),
    filterCountdownThresholdSec: parseIntEnv(
      env.EVENTS_FILTER_COUNTDOWN_THRESHOLD_SEC,
      DEFAULTS.filterCountdownThresholdSec,
    ),
  });
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/// Decimal-ether → wei. `"0.5"` → `500000000000000000n`. Falls back on parse failure.
function parseWeiEnv(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return fallback;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  try {
    return BigInt(whole ?? "0") * 10n ** 18n + BigInt(fracPadded || "0");
  } catch {
    return fallback;
  }
}
