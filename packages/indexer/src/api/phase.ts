/// Phase + cadence helpers shared between API endpoints.
///
/// The contract phase machine has 5 states (Launch / Filter / Finals / Settlement / Closed),
/// but the public API surfaces 4 (`launch` / `competition` / `finals` / `settled`) per spec
/// §26.4 — Settlement and Closed both fold into `settled` since they look identical to a
/// spectator (winner has been selected, prize flow has been executed).
///
/// Cadence is derived from `season.startedAt` + the locked anchors in `@filter-fun/cadence`
/// (spec §3.2 + §36.1.5 + §33.6, locked 2026-04-30):
///   - Day 1–2 (0–48h):   launch window
///   - Day 4 (96h):        first hard cut (12 → 6)
///   - Day 7 (168h):       final settlement
///   - No Day 5 soft filter (spec §33.6 resolved off)
///
/// We derive next-cut and final-settlement timestamps from the on-chain `startedAt` rather
/// than indexing dedicated cadence events. The cadence module is the single source of truth
/// — both the indexer (here) and the scheduler import the same constants, so the API and the
/// on-chain phase advances cannot drift.

import {hoursToSec, loadCadence, type Cadence} from "@filter-fun/cadence";

export type ContractPhase = "Launch" | "Filter" | "Finals" | "Settlement" | "Closed";
export type ApiPhase = "launch" | "competition" | "finals" | "settled";

/// Cadence read once at module-init from process env. Override via `SEASON_HARD_CUT_HOUR=…`
/// etc. — see `@filter-fun/cadence` README. Failing here aborts indexer startup (intentional;
/// silent fallback to default would mis-time settlement on Phase 2 mainnet).
const cadence: Cadence = loadCadence();

const FIRST_CUT_OFFSET_SEC = hoursToSec(cadence.hardCutHour);
const FINAL_SETTLEMENT_OFFSET_SEC = hoursToSec(cadence.settlementHour);

export function toApiPhase(p: ContractPhase | string): ApiPhase {
  switch (p) {
    case "Launch":
      return "launch";
    case "Filter":
      return "competition";
    case "Finals":
      return "finals";
    case "Settlement":
    case "Closed":
      return "settled";
    default:
      return "launch";
  }
}

/// Returns the next-cut timestamp as Unix seconds (bigint). Returns `null` for `settled`
/// phase since no future cut is expected. Used by the events detector to gate
/// FILTER_COUNTDOWN on time-to-cut without re-parsing ISO strings.
export function nextCutEpochSec(startedAtSec: bigint, phase: ApiPhase): bigint | null {
  if (phase === "settled") return null;
  const offset = phase === "launch" || phase === "competition"
    ? FIRST_CUT_OFFSET_SEC
    : FINAL_SETTLEMENT_OFFSET_SEC;
  return startedAtSec + offset;
}

/// Returns the ISO8601 timestamp of the next cut event for `season`.
///
/// - In `launch` / `competition` phase: next cut = startedAt + 96h (Day 4 first cut).
/// - In `finals`: next cut = startedAt + 168h (final settlement is the next "cut").
/// - In `settled`: returns the final-settlement timestamp (already past, surfaced as historical).
export function nextCutAtIso(startedAtSec: bigint, phase: ApiPhase): string {
  const offset = phase === "launch" || phase === "competition"
    ? FIRST_CUT_OFFSET_SEC
    : FINAL_SETTLEMENT_OFFSET_SEC;
  return secondsToIso(startedAtSec + offset);
}

export function finalSettlementAtIso(startedAtSec: bigint): string {
  return secondsToIso(startedAtSec + FINAL_SETTLEMENT_OFFSET_SEC);
}

function secondsToIso(sec: bigint): string {
  // bigint seconds → JS Date (ms). Safe as Number since seasons live in Unix
  // time; precision loss above year 285,427,624,033 isn't a concern.
  return new Date(Number(sec) * 1000).toISOString();
}
