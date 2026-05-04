"use client";

/// Polls `/profile/:address?role=creator` for the wallet's creator-keyed
/// surface (Epic 1.23). Used by the admin console's "past tokens" panel.
/// Re-arms on wallet change like `useHoldings`. The default 60s interval is
/// looser than holdings — the past-tokens list rarely changes, only when the
/// creator launches a new token or a season finalizes.

import {useEffect, useState} from "react";

import {fetchProfile, type ProfileResponse} from "@/lib/arena/api";

const DEFAULT_INTERVAL_MS = 60_000;

export type UsePastTokensResult = {
  data: ProfileResponse | null;
  error: Error | null;
  isLoading: boolean;
};

export function usePastTokens(
  wallet: `0x${string}` | null | undefined,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): UsePastTokensResult {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(wallet));

  useEffect(() => {
    if (!wallet) {
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
        const next = await fetchProfile(wallet, {signal: abort.signal, role: "creator"});
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
  }, [wallet, intervalMs]);

  return {data, error, isLoading};
}
