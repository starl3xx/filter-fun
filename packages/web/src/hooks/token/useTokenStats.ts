"use client";

import {useMemo} from "react";
import type {Address} from "viem";

import type {TokenResponse} from "@/lib/arena/api";

import {useTokens} from "../arena/useTokens";

/// Derives competitive stats for a single token from the cohort served by
/// `/tokens`. Returns the matched token plus a `cutLineDistance` describing
/// position relative to the spec §3.2 hard cut (top 6 survive).
///
/// Status mapping:
///   rank ≤ 6 → "SAFE"  (above cut)
///   rank ≤ 9 → "AT_RISK" (in cut zone)
///   rank ≥ 10 → "DANGER" (clearly below cut)
///   token.status === "FILTERED" → "FILTERED" (post-cut)
///   token.status === "FINALIST" → "FINALIST" (already locked in)
///
/// `distance` is the absolute |rank - SURVIVE_COUNT| with sign carrying the
/// SAFE/AT_RISK semantic. We compute against rank rather than HP because rank
/// is the cut criterion; a token can have HP 80 and still be filtered if 6
/// others have higher HP.

export type CutLineStatus = "SAFE" | "AT_RISK" | "DANGER" | "FINALIST" | "FILTERED";

export type TokenStats = {
  token: TokenResponse | null;
  cutLineStatus: CutLineStatus;
  /// Absolute distance to the cut line in ranks. Always non-negative.
  cutLineDistance: number;
  /// Pre-formatted display string: "SAFE by 4" / "AT RISK by 1" / "FILTERED".
  cutLineLabel: string;
};

const SURVIVE_COUNT = 6;

export function useTokenStats(address: Address | null): {
  stats: TokenStats;
  isLoading: boolean;
} {
  const {data: tokens, isLoading} = useTokens();

  const stats = useMemo<TokenStats>(() => {
    if (!address || !tokens) {
      return {token: null, cutLineStatus: "SAFE", cutLineDistance: 0, cutLineLabel: ""};
    }
    const token = tokens.find((t) => t.token.toLowerCase() === address.toLowerCase()) ?? null;
    if (!token) {
      return {token: null, cutLineStatus: "SAFE", cutLineDistance: 0, cutLineLabel: ""};
    }
    return computeStats(token);
  }, [address, tokens]);

  return {stats, isLoading};
}

/// Pure computation — exported so unit tests can exercise the rank → label
/// mapping without rendering React.
export function computeStats(token: TokenResponse): TokenStats {
  // Existing FINALIST/FILTERED states from the indexer take precedence — they
  // reflect on-chain state, not a derived rank threshold.
  if (token.status === "FINALIST") {
    return {
      token,
      cutLineStatus: "FINALIST",
      cutLineDistance: 0,
      cutLineLabel: "FINALIST",
    };
  }
  if (token.status === "FILTERED") {
    return {
      token,
      cutLineStatus: "FILTERED",
      cutLineDistance: 0,
      cutLineLabel: "FILTERED",
    };
  }
  // Unscored (rank 0) — pre-cut, we treat as SAFE with distance 0.
  if (token.rank === 0) {
    return {
      token,
      cutLineStatus: "SAFE",
      cutLineDistance: 0,
      cutLineLabel: "Unscored",
    };
  }
  if (token.rank <= SURVIVE_COUNT) {
    const distance = SURVIVE_COUNT - token.rank;
    if (token.rank >= SURVIVE_COUNT - 1) {
      // Rank 5 or 6: still safe, but the next slip filters them.
      return {
        token,
        cutLineStatus: "AT_RISK",
        cutLineDistance: distance,
        cutLineLabel: `AT RISK by ${distance}`,
      };
    }
    return {
      token,
      cutLineStatus: "SAFE",
      cutLineDistance: distance,
      cutLineLabel: `SAFE by ${distance}`,
    };
  }
  const distance = token.rank - SURVIVE_COUNT;
  return {
    token,
    cutLineStatus: "DANGER",
    cutLineDistance: distance,
    cutLineLabel: `BELOW CUT by ${distance}`,
  };
}
