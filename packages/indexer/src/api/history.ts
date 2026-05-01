/// Pure handler for `GET /tokens/:address/history`.
///
/// Returns a downsampled HP timeseries for one token from the `hp_snapshot` rows the
/// indexer's block-interval handler writes (see `src/HpSnapshot.ts`). Default range is
/// the trailing 7 days; the request can override `from` / `to` (unix seconds) and
/// `interval` (seconds, default 300 = 5 min). Range is hard-capped at 30 days so a
/// single request can't ask for the full history of an old token.
///
/// Bucketing: snapshots are bucketed into floor-aligned `interval`-sized windows
/// (by `Math.floor(snapshotAtSec / interval) * interval`) and the LATEST sample within
/// each window wins. This matches what the admin console drilldown wants — it's
/// rendering "HP at the end of each 5-min window," not an average. Empty buckets are
/// gaps; the response is sparse rather than backfilled with zeros.
///
/// Wire shape:
///
/// ```json
/// {
///   "token": "0x...",
///   "from": 1700000000,
///   "to":   1700604800,
///   "interval": 300,
///   "points": [
///     {
///       "timestamp": 1700000000,
///       "hp": 82,
///       "rank": 3,
///       "phase": "competition",
///       "components": {
///         "velocity": 0.74,
///         "effectiveBuyers": 0.62,
///         "stickyLiquidity": 0.41,
///         "retention": 0.55,
///         "momentum": 0.50
///       }
///     }
///   ]
/// }
/// ```

import {isAddressLike} from "./builders.js";
import type {ApiPhase} from "./phase.js";

export const HISTORY_DEFAULT_INTERVAL_SEC = 300; // 5 min
export const HISTORY_DEFAULT_RANGE_SEC = 7 * 24 * 60 * 60; // 7 days
export const HISTORY_MAX_RANGE_SEC = 30 * 24 * 60 * 60; // 30 days
export const HISTORY_MIN_INTERVAL_SEC = 60; // 1 min — protect the DB from /history?interval=1
export const HISTORY_MAX_INTERVAL_SEC = 24 * 60 * 60; // 1 day

export interface HpSnapshotRow {
  token: `0x${string}`;
  snapshotAtSec: bigint;
  hp: number;
  rank: number;
  velocity: number;
  effectiveBuyers: number;
  stickyLiquidity: number;
  retention: number;
  momentum: number;
  phase: string;
}

export interface HistoryQueries {
  /// Fetch raw HP snapshots for `token` between [`fromSec`, `toSec`] inclusive.
  /// Implementation must return rows ordered by `snapshotAtSec` ascending; the
  /// bucketer below is correctness-dependent on monotonic input.
  hpSnapshotsForToken: (
    token: `0x${string}`,
    fromSec: bigint,
    toSec: bigint,
  ) => Promise<HpSnapshotRow[]>;
}

export interface HistoryPoint {
  timestamp: number;
  hp: number;
  rank: number;
  phase: ApiPhase | string; // phase is whatever the snapshot wrote; tests pin via ApiPhase
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
  };
}

export interface HistoryResponse {
  token: `0x${string}`;
  from: number;
  to: number;
  interval: number;
  points: HistoryPoint[];
}

export interface HistoryOpts {
  /// Unix seconds; tests inject a fixed clock so `to` defaults are deterministic.
  nowSec: bigint;
}

export interface HistoryParams {
  from?: string;
  to?: string;
  interval?: string;
}

export async function getTokenHistoryHandler(
  q: HistoryQueries,
  rawAddress: string,
  params: HistoryParams,
  opts: HistoryOpts,
): Promise<{status: number; body: HistoryResponse | {error: string}}> {
  const lower = rawAddress.toLowerCase();
  if (!isAddressLike(lower)) return {status: 400, body: {error: "invalid address"}};

  const interval = parseInterval(params.interval);
  if (interval === null) {
    return {
      status: 400,
      body: {
        error: `interval must be an integer between ${HISTORY_MIN_INTERVAL_SEC} and ${HISTORY_MAX_INTERVAL_SEC} seconds`,
      },
    };
  }

  const range = parseRange(params.from, params.to, opts.nowSec);
  if ("error" in range) return {status: 400, body: {error: range.error}};

  const rows = await q.hpSnapshotsForToken(
    lower as `0x${string}`,
    range.fromSec,
    range.toSec,
  );

  return {
    status: 200,
    body: {
      token: lower as `0x${string}`,
      from: Number(range.fromSec),
      to: Number(range.toSec),
      interval,
      points: bucketize(rows, interval),
    },
  };
}

// ============================================================ helpers (exported for tests)

export function parseInterval(raw: string | undefined): number | null {
  if (raw === undefined) return HISTORY_DEFAULT_INTERVAL_SEC;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < HISTORY_MIN_INTERVAL_SEC || n > HISTORY_MAX_INTERVAL_SEC) return null;
  return n;
}

export function parseRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  nowSec: bigint,
): {fromSec: bigint; toSec: bigint} | {error: string} {
  let toSec: bigint;
  if (toRaw === undefined) {
    toSec = nowSec;
  } else {
    const n = Number.parseInt(toRaw, 10);
    if (!Number.isFinite(n)) return {error: "to must be unix seconds"};
    toSec = BigInt(n);
  }
  let fromSec: bigint;
  if (fromRaw === undefined) {
    fromSec = toSec - BigInt(HISTORY_DEFAULT_RANGE_SEC);
  } else {
    const n = Number.parseInt(fromRaw, 10);
    if (!Number.isFinite(n)) return {error: "from must be unix seconds"};
    fromSec = BigInt(n);
  }
  if (fromSec >= toSec) return {error: "from must be strictly less than to"};
  if (toSec - fromSec > BigInt(HISTORY_MAX_RANGE_SEC)) {
    return {error: `range exceeds ${HISTORY_MAX_RANGE_SEC}-second cap (30 days)`};
  }
  return {fromSec, toSec};
}

/// Buckets snapshot rows into floor-aligned `interval`-sized windows. Within each
/// bucket, the latest sample (by `snapshotAtSec`) wins — the timeseries renders the
/// "HP at end of bucket" so a UI sparkline reads naturally as monotonically advancing
/// time. Empty buckets are absent (sparse output) so a render layer can choose to
/// gap or interpolate.
export function bucketize(
  rows: ReadonlyArray<HpSnapshotRow>,
  intervalSec: number,
): HistoryPoint[] {
  if (rows.length === 0) return [];
  const interval = BigInt(intervalSec);
  // Map<bucketStart, latestRow>
  const byBucket = new Map<bigint, HpSnapshotRow>();
  for (const r of rows) {
    const bucket = (r.snapshotAtSec / interval) * interval;
    const existing = byBucket.get(bucket);
    if (!existing || r.snapshotAtSec > existing.snapshotAtSec) {
      byBucket.set(bucket, r);
    }
  }
  const ordered = [...byBucket.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return ordered.map(([bucket, r]) => ({
    timestamp: Number(bucket),
    hp: r.hp,
    rank: r.rank,
    phase: r.phase,
    components: {
      velocity: r.velocity,
      effectiveBuyers: r.effectiveBuyers,
      stickyLiquidity: r.stickyLiquidity,
      retention: r.retention,
      momentum: r.momentum,
    },
  }));
}
