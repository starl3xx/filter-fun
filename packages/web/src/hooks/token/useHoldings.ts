"use client";

/// Polls `/wallets/:address/holdings` (Epic 1.23). Wallet-keyed: the fetcher
/// re-arms whenever the address changes (connect / disconnect / switch). When
/// `wallet` is null/undefined the hook returns the empty state without firing
/// any request.
///
/// Visibility-aware via the same `document.visibilitychange` plumbing as
/// `usePoll`, just inlined here because the fetcher closes over a value
/// (the wallet) that the parent can change at runtime — `usePoll` only
/// re-arms on `intervalMs`, so it can't be reused as-is.
///
/// `enabled` (Bugbot PR #101 follow-up) defers polling on consumers that
/// only need holdings during specific UI states. The arena homepage uses
/// holdings ONLY during the filter-moment ceremony (countdown → firing →
/// recap) — passing `enabled: filterMoment.stage !== "idle"` keeps the
/// hook quiet on the high-traffic idle path while the admin console (which
/// always needs holdings) keeps the default `enabled: true`.

import {useEffect, useState} from "react";

import {fetchHoldings, type HoldingsResponse} from "@/lib/arena/api";

const DEFAULT_INTERVAL_MS = 30_000; // 30s — matches the admin console's auto-refetch cadence

export type UseHoldingsResult = {
  data: HoldingsResponse | null;
  error: Error | null;
  isLoading: boolean;
};

export function useHoldings(
  wallet: `0x${string}` | null | undefined,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  enabled: boolean = true,
): UseHoldingsResult {
  const [data, setData] = useState<HoldingsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(wallet) && enabled);

  useEffect(() => {
    if (!wallet || !enabled) {
      // Bugbot PR #101 follow-up: don't keep stale data around after a
      // consumer disables the hook (e.g. filter-moment returning to idle) —
      // the next enable should re-fetch fresh.
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    setIsLoading(true);

    const tick = async () => {
      abort?.abort();
      abort = new AbortController();
      let aborted = false;
      try {
        const next = await fetchHoldings(wallet, {signal: abort.signal});
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
  }, [wallet, intervalMs, enabled]);

  return {data, error, isLoading};
}
