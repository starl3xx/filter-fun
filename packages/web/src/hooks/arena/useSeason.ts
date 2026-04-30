"use client";

import {fetchSeason, type SeasonResponse} from "@/lib/arena/api";

import {usePoll, type UsePollResult} from "./usePoll";

/// Polls `/season` every `intervalMs` (default 4s — between the 3-5s window
/// spec'd by the data-flow brief, matching the server's cache TTL).
///
/// All polling mechanics (abort handling, visibility gating, reschedule
/// safety) live in `usePoll<T>` so behavior stays in lockstep with `useTokens`.

export type UseSeasonResult = UsePollResult<SeasonResponse>;

const DEFAULT_INTERVAL_MS = 4_000;

export function useSeason(intervalMs: number = DEFAULT_INTERVAL_MS): UseSeasonResult {
  return usePoll(fetchSeason, intervalMs);
}
