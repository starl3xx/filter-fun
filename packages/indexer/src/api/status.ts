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
///   3. rank ≤ 6                                   → SAFE
///   4. rank 7–9                                   → AT_RISK
///   5. rank ≥ 10                                  → FILTERED  (about to be cut at next phase)
///
/// During the `launch` phase no rank is meaningful (cohort still forming), so callers pass
/// rank as 0 to opt out of the rank-based branches and the result falls through to SAFE.

import type {ApiPhase} from "./phase.js";

export type TokenStatus = "SAFE" | "AT_RISK" | "FINALIST" | "FILTERED";

export interface StatusInputs {
  phase: ApiPhase;
  rank: number; // 1-based; 0 means "no cohort rank yet" (e.g. in launch)
  isFinalist: boolean;
  liquidated: boolean;
}

export function statusOf(i: StatusInputs): TokenStatus {
  if (i.liquidated) return "FILTERED";
  if (i.isFinalist) return "FINALIST";
  // Pre-rank period (launch) → just SAFE.
  if (i.rank <= 0) return "SAFE";
  if (i.rank <= 6) return "SAFE";
  if (i.rank <= 9) return "AT_RISK";
  return "FILTERED";
}
