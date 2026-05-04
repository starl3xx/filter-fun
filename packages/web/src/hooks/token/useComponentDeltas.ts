"use client";

/// Polls `/tokens/:address/component-deltas` (Epic 1.23). Token-keyed: re-arms
/// when the address changes. Lazy by default — the hook only fetches when
/// `enabled` is true so an unopened drilldown doesn't burn rate-limit budget.
/// Once any component is opened, the consumer flips `enabled` to start
/// polling; subsequent open/close transitions don't re-arm because the data
/// is already in memory.

import {useEffect, useState} from "react";

import {fetchComponentDeltas, type ComponentDeltasResponse} from "@/lib/arena/api";

const DEFAULT_INTERVAL_MS = 30_000;

export type UseComponentDeltasResult = {
  data: ComponentDeltasResponse | null;
  error: Error | null;
  isLoading: boolean;
};

export function useComponentDeltas(
  tokenAddress: `0x${string}` | null | undefined,
  enabled: boolean,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): UseComponentDeltasResult {
  const [data, setData] = useState<ComponentDeltasResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!enabled || !tokenAddress) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    setIsLoading(true);

    const tick = async () => {
      abort?.abort();
      abort = new AbortController();
      let aborted = false;
      try {
        const next = await fetchComponentDeltas(tokenAddress, {}, {signal: abort.signal});
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
  }, [tokenAddress, enabled, intervalMs]);

  return {data, error, isLoading};
}
