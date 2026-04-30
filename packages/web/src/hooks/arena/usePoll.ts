"use client";

import {useEffect, useRef, useState} from "react";

/// Generic visibility-aware polling hook.
///
/// `useSeason` and `useTokens` were ~95% identical before — same abort
/// controller dance, same visibility gate, same reschedule logic. They now
/// reduce to thin wrappers over `usePoll<T>` so a single fix to the polling
/// rules (abort race, error handling, visibility behavior) applies
/// uniformly.
///
/// Behavior:
///   - Fires `fetcher` immediately on mount, then every `intervalMs`.
///   - Each tick aborts any in-flight request from the previous tick — so
///     visibilitychange's "clear-and-restart" path doesn't double-poll.
///   - Skips polling while the tab is hidden (visibilitychange).
///   - On visibility return, kicks off a fresh tick immediately.
///   - `aborted` flag short-circuits the finally reschedule so a sibling
///     tick (which aborted us) doesn't leave the previous chain queueing
///     a new timer alongside it. Without this each hide/show cycle compounds
///     a parallel polling loop.

export type UsePollResult<T> = {
  /// Latest successful response, or `null` before first fetch.
  data: T | null;
  /// Last error if the most recent attempt failed; cleared on next success.
  error: Error | null;
  /// True only on the initial fetch.
  isLoading: boolean;
};

export type Fetcher<T> = (opts: {signal: AbortSignal}) => Promise<T>;

export function usePoll<T>(fetcher: Fetcher<T>, intervalMs: number): UsePollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Stash the fetcher in a ref so changing the function identity (e.g. an
  // inline arrow at the call-site) doesn't re-fire the effect — only
  // `intervalMs` should drive a re-arm.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;

    const tick = async () => {
      abort?.abort();
      abort = new AbortController();
      let aborted = false;
      try {
        const next = await fetcherRef.current({signal: abort.signal});
        if (!mounted) return;
        setData(next);
        setError(null);
      } catch (e) {
        if ((e as {name?: string}).name === "AbortError") {
          aborted = true;
          return;
        }
        if (!mounted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (mounted && !aborted) setIsLoading(false);
        if (!aborted && mounted && document.visibilityState !== "hidden") {
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
      mounted = false;
      if (timer) clearTimeout(timer);
      abort?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return {data, error, isLoading};
}
