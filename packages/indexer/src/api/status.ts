/// Token status mapping used by the `/tokens` endpoint.
///
/// The status surfaces "where this token sits in the season" to the spectator UI in a
/// single label. The precedence chain is intentional — once a token has been filtered or
/// crowned a finalist on-chain, its rank-derived status is meaningless and we lean on the
/// indexed flag instead.
///
/// Precedence (highest first):
///   1. `liquidated` (filter event unwound the LP) → FILTERED
///   2. `isFinalist`                               → FINALIST
///   3. `phase === "launch"`                       → SAFE (cohort still forming, no cut threat)
///   4. rank ≤ 6                                   → SAFE
///   5. rank 7–9                                   → AT_RISK
///   6. rank ≥ 10                                  → FILTERED  (about to be cut at next phase)
///
/// During the `launch` phase rank is not meaningful: launches are still arriving and no
/// cut is imminent. Without the explicit phase check, the cohort min-max normalization in
/// `score()` could still hand back arbitrary ranks 1–N during launch, which would
/// incorrectly bucket tokens as AT_RISK / FILTERED before any competition has started.

import type {ApiPhase} from "./phase.js";

export type TokenStatus = "SAFE" | "AT_RISK" | "FINALIST" | "FILTERED";

export interface StatusInputs {
  phase: ApiPhase;
  rank: number; // 1-based; 0 means "no cohort rank yet"
  isFinalist: boolean;
  liquidated: boolean;
}

export function statusOf(i: StatusInputs): TokenStatus {
  if (i.liquidated) return "FILTERED";
  if (i.isFinalist) return "FINALIST";
  // Launch phase: no token is at risk yet — the leaderboard exists but it's pre-cut.
  if (i.phase === "launch") return "SAFE";
  // Outside launch, rank 0 means "unscored" — treat as SAFE rather than asserting.
  if (i.rank <= 0) return "SAFE";
  if (i.rank <= 6) return "SAFE";
  if (i.rank <= 9) return "AT_RISK";
  return "FILTERED";
}
