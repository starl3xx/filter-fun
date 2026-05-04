"use client";

/// /season/:id/launch-status hook — Epic 1.15c.
///
/// Reads the indexer's per-season reservation rollup (escrow totals + per-slot
/// reservation rows). Used by the SlotGrid to overlay reservation lifecycle
/// status onto empty (pre-launch) slots.
///
/// Two refresh paths share one fetch implementation:
///   1. **Periodic poll** — every 15s, the consistency anchor that catches
///      anything the SSE stream missed (network drops, browser sleep, cold
///      load). 15s is loose because SSE drives the fast path.
///   2. **SSE stream** — `/season/:id/launch/stream` emits one frame per
///      reservation lifecycle event. Each frame triggers an immediate refetch.
///      Idempotent — repeating a fetch under SSE pressure produces a stable
///      response (same data shape, same row order by slotIndex).

import {useEffect, useRef, useState} from "react";

import {
  fetchLaunchStatus,
  launchStreamUrl,
  type LaunchStatusResponse,
} from "@/lib/arena/api";

const POLL_INTERVAL_MS = 15_000;
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export type LaunchStatusResult = {
  data: LaunchStatusResponse | null;
  /// True before the first response lands. After that stays false even on
  /// re-poll so the UI doesn't flicker between "loading" and "loaded".
  loading: boolean;
  error: string | null;
};

export type UseLaunchStatusOpts = {
  /// Test seam — production omits this and the hook uses the real EventSource.
  eventSourceFactory?: (url: string) => EventSourceLike;
};

/// Minimal subset of the EventSource API the hook actually uses. Mirrors the
/// equivalent type in `useTickerEvents.ts` (kept local so neither hook depends
/// on the other).
export interface EventSourceLike {
  addEventListener: (type: string, listener: (event: MessageEvent | Event) => void) => void;
  removeEventListener: (type: string, listener: (event: MessageEvent | Event) => void) => void;
  close: () => void;
  readyState: number;
}

export function useLaunchStatus(
  seasonId: number | bigint | null | undefined,
  opts: UseLaunchStatusOpts = {},
): LaunchStatusResult {
  const [state, setState] = useState<LaunchStatusResult>({
    data: null,
    loading: true,
    error: null,
  });
  const factoryRef = useRef(opts.eventSourceFactory ?? defaultFactory);
  factoryRef.current = opts.eventSourceFactory ?? defaultFactory;

  useEffect(() => {
    if (seasonId === null || seasonId === undefined) {
      setState({data: null, loading: false, error: null});
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSourceLike | null = null;
    let attempts = 0;

    async function tick(): Promise<void> {
      try {
        const r = await fetchLaunchStatus(seasonId as number | bigint, {signal: controller.signal});
        if (cancelled) return;
        setState({data: r, loading: false, error: null});
      } catch (err) {
        if ((err as Error).name === "AbortError" || cancelled) return;
        setState((s) => ({
          ...s,
          loading: false,
          // Keep the last good `data` so a transient blip doesn't drop the surface.
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    function connect(): void {
      if (cancelled) return;
      const url = launchStreamUrl(seasonId as number | bigint);
      try {
        es = factoryRef.current(url);
      } catch {
        // EventSource constructor failed (test env without polyfill, etc).
        // The poll loop still runs — SSE is a fast path, not a hard dep.
        return;
      }
      const onLaunch = (): void => {
        // Don't trust the frame's data — refetch the canonical shape so the
        // UI sees the same rows regardless of the stream's per-frame payload.
        void tick();
      };
      const onOpen = (): void => {
        attempts = 0;
      };
      const onError = (): void => {
        if (cancelled) return;
        try {
          es?.close();
        } catch {
          // ignore
        }
        es = null;
        const delay = Math.min(RECONNECT_INITIAL_MS * 2 ** attempts, RECONNECT_MAX_MS);
        attempts++;
        reconnectTimer = setTimeout(connect, delay);
      };
      es.addEventListener("launch", onLaunch);
      es.addEventListener("open", onOpen);
      es.addEventListener("error", onError);
    }

    void tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    connect();

    return () => {
      cancelled = true;
      controller.abort();
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) {
        try {
          es.close();
        } catch {
          // ignore
        }
      }
    };
  }, [seasonId]);

  return state;
}

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}
