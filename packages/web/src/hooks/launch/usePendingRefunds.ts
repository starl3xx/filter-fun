"use client";

/// /wallet/:address/pending-refunds hook — Epic 1.15c.
///
/// Returns the connected wallet's unclaimed refund slots. Polls every 30s
/// (low-frequency: refunds change only on abort + claim, neither of which is
/// per-second) and refetches when the address changes. Surface intent: drive
/// a banner on /launch with a per-season "Claim refund" CTA.
///
/// Returns `pending: []` when the wallet has no unclaimed slots, or the wallet
/// is disconnected. Errors are surfaced via `error` but do NOT clear `pending`
/// — a transient network blip shouldn't visually drop the banner.

import {useEffect, useState} from "react";

import {fetchPendingRefunds, type PendingRefundsResponse} from "@/lib/arena/api";

const POLL_INTERVAL_MS = 30_000;

export type UsePendingRefundsResult = {
  data: PendingRefundsResponse | null;
  loading: boolean;
  error: string | null;
};

export function usePendingRefunds(
  wallet: `0x${string}` | null | undefined,
): UsePendingRefundsResult {
  const [state, setState] = useState<UsePendingRefundsResult>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!wallet) {
      setState({data: null, loading: false, error: null});
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function tick(): Promise<void> {
      try {
        const r = await fetchPendingRefunds(wallet as `0x${string}`, {signal: controller.signal});
        if (cancelled) return;
        setState({data: r, loading: false, error: null});
      } catch (err) {
        if ((err as Error).name === "AbortError" || cancelled) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    setState((s) => ({...s, loading: true}));
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [wallet]);

  return state;
}
