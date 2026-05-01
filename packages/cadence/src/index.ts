/// Single source of truth for filter.fun season cadence — every hour-anchor that the
/// scheduler invokes phase advances at, and that the indexer reports via `/season`, lives
/// here. Both packages import from this module; nothing else duplicates the numbers.
///
/// Spec anchors (locked 2026-04-30):
///   §3.2     — Recommended Season Timeline
///   §36.1.5  — Filter timing explicit cadence
///   §33.6    — Day 5 soft filter resolved OFF
///
/// Locked timeline:
///   Hour   0 –  48 : Launch window (12 slots, FCFS, dynamic cost)
///   Hour  48 –  96 : Trading-only window (full field of 12, no eliminations)
///   Hour       96 : First filter — 12 → 6 (HARD CUT)
///   Hour  96 – 168 : Finals (6 tokens compete)
///   Hour      168 : Settlement
///
/// Day-of-week mapping: Monday launch / Thursday cut / Sunday winner.
///
/// The cadence is intentionally OFF-CHAIN: contracts only know about phases (LAUNCH /
/// FILTER / FINALS / SETTLEMENT) via `advancePhase()`; they don't know hours. The scheduler
/// (or whatever harness invokes it — k8s cron, Railway, manual ops) is responsible for
/// firing `advancePhase()` at the hour anchors below.
///
/// `softFilterEnabled` defaults to `false`. The flag exists for forward compatibility — if
/// the Day 5 soft filter is ever revisited (spec §33.6), the wire is already in place — but
/// no implementation is shipped today.

export interface Cadence {
  /// Hours from `season.startedAt` at which the launch window closes (no further launches).
  launchEndHour: bigint;
  /// Hours from `season.startedAt` at which the first hard cut fires (12 → 6).
  hardCutHour: bigint;
  /// Hours from `season.startedAt` at which final settlement runs (winner crowned).
  settlementHour: bigint;
  /// Forward-compat flag. Always `false` on production today (spec §33.6).
  softFilterEnabled: boolean;
}

/// Default cadence per spec. Treat as read-only.
export const DEFAULT_CADENCE: Cadence = {
  launchEndHour: 48n,
  hardCutHour: 96n,
  settlementHour: 168n,
  softFilterEnabled: false,
};

/// Hours-to-seconds helper. Exported so consumers can do their own bigint math
/// (`startedAtSec + hoursToSec(hardCutHour)`) without re-introducing a literal `3600`.
export const SECONDS_PER_HOUR = 3600n;

export function hoursToSec(hours: bigint): bigint {
  return hours * SECONDS_PER_HOUR;
}

/// Read cadence overrides from process env. Returns `DEFAULT_CADENCE` when no overrides are
/// set. Throws on invalid input — bad values fail loudly rather than silently falling back,
/// because a misconfigured cadence would mis-time settlement (with real money on Phase 2
/// mainnet, that's a data-loss-class bug).
///
/// Recognized env vars (all optional):
///   SEASON_LAUNCH_END_HOUR        positive integer; default 48
///   SEASON_HARD_CUT_HOUR          positive integer; default 96; must be > launchEnd
///   SEASON_SETTLEMENT_HOUR        positive integer; default 168; must be > hardCut
///   SEASON_SOFT_FILTER_ENABLED    "true" | "false" | "1" | "0"; default false
///
/// Pass `env` explicitly to test; defaults to `process.env`.
export function loadCadence(env: NodeJS.ProcessEnv = process.env): Cadence {
  const launchEndHour = parseHourEnv(env, "SEASON_LAUNCH_END_HOUR", DEFAULT_CADENCE.launchEndHour);
  const hardCutHour = parseHourEnv(env, "SEASON_HARD_CUT_HOUR", DEFAULT_CADENCE.hardCutHour);
  const settlementHour = parseHourEnv(env, "SEASON_SETTLEMENT_HOUR", DEFAULT_CADENCE.settlementHour);
  const softFilterEnabled = parseBoolEnv(env, "SEASON_SOFT_FILTER_ENABLED", DEFAULT_CADENCE.softFilterEnabled);

  if (hardCutHour <= launchEndHour) {
    throw new Error(
      `cadence: SEASON_HARD_CUT_HOUR (${hardCutHour}) must be > SEASON_LAUNCH_END_HOUR (${launchEndHour})`,
    );
  }
  if (settlementHour <= hardCutHour) {
    throw new Error(
      `cadence: SEASON_SETTLEMENT_HOUR (${settlementHour}) must be > SEASON_HARD_CUT_HOUR (${hardCutHour})`,
    );
  }

  return {launchEndHour, hardCutHour, settlementHour, softFilterEnabled};
}

function parseHourEnv(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  // Reject non-integer and non-positive values up-front. `BigInt(raw)` would happily accept
  // `"-5"` or `"0"`; a negative cadence anchor is meaningless and a zero would collapse two
  // phase boundaries onto each other, so we filter both out explicitly.
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`cadence: ${key} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return BigInt(raw.trim());
}

function parseBoolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`cadence: ${key} must be true/false/1/0 (got ${JSON.stringify(raw)})`);
}
