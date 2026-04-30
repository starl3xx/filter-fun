"use client";

import {useEffect, useRef, useState} from "react";

import {fetchSeason, type SeasonResponse} from "@/lib/arena/api";

/// Polls `/season` every `intervalMs` (default 4s — between the 3-5s window
/// spec'd by the data-flow brief, matching the server's cache TTL).
///
/// Returns:
///   - `data`: latest successful response, or `null` before first fetch
///   - `error`: last error if the most recent attempt failed (cleared on next success)
///   - `isLoading`: true only on the initial fetch
///
/// Polls are skipped while the tab is hidden (visibility API) so we don't
/// burn requests for spectators that aren't watching, then resume + force a
/// fetch on visibility return.

export type UseSeasonResult = {
  data: SeasonResponse | null;
  error: Error | null;
  isLoading: boolean;
};

const DEFAULT_INTERVAL_MS = 4_000;

export function useSeason(intervalMs: number = DEFAULT_INTERVAL_MS): UseSeasonResult {
  const [data, setData] = useState<SeasonResponse | null>(null);
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
        const next = await fetchSeason({signal: abort.signal});
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
