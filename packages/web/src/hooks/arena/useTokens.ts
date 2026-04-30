"use client";

import {useEffect, useRef, useState} from "react";

import {fetchTokens, type TokenResponse} from "@/lib/arena/api";

/// Polls `/tokens` every `intervalMs` (default 6s — middle of the 5-10s
/// window). Returns the cohort sorted server-side by ascending rank (with
/// rank-0 / unscored tokens at the end).
///
/// See `useSeason` — same contract, same visibility-aware polling pattern.

export type UseTokensResult = {
  data: TokenResponse[] | null;
  error: Error | null;
  isLoading: boolean;
};

const DEFAULT_INTERVAL_MS = 6_000;

export function useTokens(intervalMs: number = DEFAULT_INTERVAL_MS): UseTokensResult {
  const [data, setData] = useState<TokenResponse[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;

    const tick = async () => {
      abort?.abort();
      abort = new AbortController();
      try {
        const next = await fetchTokens({signal: abort.signal});
        if (!mounted.current) return;
        setData(next);
        setError(null);
      } catch (e) {
        if ((e as {name?: string}).name === "AbortError") return;
        if (!mounted.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (mounted.current) setIsLoading(false);
        if (mounted.current && document.visibilityState !== "hidden") {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        tick();
      }
    };

    tick();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
      abort?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return {data, error, isLoading};
}
