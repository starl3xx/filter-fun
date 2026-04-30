/// Phase + cadence helpers shared between API endpoints.
///
/// The contract phase machine has 5 states (Launch / Filter / Finals / Settlement / Closed),
/// but the public API surfaces 4 (`launch` / `competition` / `finals` / `settled`) per spec
/// §26.4 — Settlement and Closed both fold into `settled` since they look identical to a
/// spectator (winner has been selected, prize flow has been executed).
///
/// Cadence is derived from `season.startedAt` + spec §36.1.5 anchors:
///   - Day 1–2 (0–48h):  launch window
///   - Day 3 (72h):       first hard cut (12 → 6)
///   - Day 7 (168h):      final settlement
///
/// We derive next-cut and final-settlement timestamps from the on-chain `startedAt` rather
/// than indexing dedicated cadence events. When Epic 1.10 lands and the contract emits
/// the actual cadence anchors, swap these helpers for direct reads.

export type ContractPhase = "Launch" | "Filter" | "Finals" | "Settlement" | "Closed";
export type ApiPhase = "launch" | "competition" | "finals" | "settled";

const HOUR = 3600n;
const FIRST_CUT_OFFSET = 72n * HOUR;
const FINAL_SETTLEMENT_OFFSET = 168n * HOUR;

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

/// Returns the ISO8601 timestamp of the next cut event for `season`.
///
/// - In `launch` / `competition` phase: next cut = startedAt + 72h (Day 3 first cut).
/// - In `finals`: next cut = startedAt + 168h (final settlement is the next "cut").
/// - In `settled`: returns the final-settlement timestamp (already past, surfaced as historical).
export function nextCutAtIso(startedAtSec: bigint, phase: ApiPhase): string {
  const offset = phase === "launch" || phase === "competition"
    ? FIRST_CUT_OFFSET
    : FINAL_SETTLEMENT_OFFSET;
  return secondsToIso(startedAtSec + offset);
}

export function finalSettlementAtIso(startedAtSec: bigint): string {
  return secondsToIso(startedAtSec + FINAL_SETTLEMENT_OFFSET);
}

function secondsToIso(sec: bigint): string {
  // bigint seconds → JS Date (ms). Safe as Number since seasons live in Unix
  // time; precision loss above year 285,427,624,033 isn't a concern.
  return new Date(Number(sec) * 1000).toISOString();
}
