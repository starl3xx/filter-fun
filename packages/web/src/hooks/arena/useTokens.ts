"use client";

import {fetchTokens, type TokenResponse} from "@/lib/arena/api";

import {usePoll, type UsePollResult} from "./usePoll";

/// Polls `/tokens` every `intervalMs` (default 6s — middle of the 5-10s
/// window). Returns the cohort sorted server-side by ascending rank (with
/// rank-0 / unscored tokens at the end).
///
/// See `usePoll` for the polling mechanics — abort handling, visibility
/// gating, reschedule safety.

export type UseTokensResult = UsePollResult<TokenResponse[]>;

const DEFAULT_INTERVAL_MS = 6_000;

export function useTokens(intervalMs: number = DEFAULT_INTERVAL_MS): UseTokensResult {
  return usePoll(fetchTokens, intervalMs);
}
