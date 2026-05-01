"use client";

import {useEffect, useRef, useState} from "react";

import {INDEXER_URL, type TickerEvent} from "@/lib/arena/api";

/// SSE subscriber for the indexer's `/events` stream. Receives `event: ticker`
/// JSON payloads, de-duplicates by `id` (defence-in-depth — the server
/// already de-duplicates), and exposes a bounded rolling buffer.
///
/// Reconnect strategy: native EventSource auto-reconnects on transient drops,
/// but on a hard `error` event we close the connection and schedule a manual
/// reconnect with exponential backoff capped at 30s — keeps a flapping
/// indexer from saturating both sides with retries.
///
/// `eventSourceFactory` is an injection seam for tests — production passes
/// the default (real `EventSource`); tests pass a fake that exposes
/// `simulateMessage` / `simulateError` to drive the hook deterministically.

export type UseTickerEventsResult = {
  /// Newest-first buffer of received events, bounded to `maxEvents`.
  events: TickerEvent[];
  /// Connection lifecycle — useful for test instrumentation and visual states.
  status: "connecting" | "open" | "reconnecting" | "closed";
};

export type UseTickerEventsOpts = {
  /// Max events retained in the rolling buffer. Tuned for the ticker (which
  /// only renders a handful at a time) and the activity feed (which renders
  /// the last ~20). Ring-buffer eviction is FIFO oldest-out.
  maxEvents?: number;
  /// Initial reconnect delay in ms; doubles each failed attempt up to `maxBackoffMs`.
  initialBackoffMs?: number;
  /// Hard cap on reconnect delay.
  maxBackoffMs?: number;
  /// Override the source URL — defaults to `${INDEXER_URL}/events`.
  url?: string;
  /// Test seam — production omits this and the hook uses the real EventSource.
  eventSourceFactory?: (url: string) => EventSourceLike;
};

/// Minimal subset of the EventSource API the hook actually uses. Lets us
/// substitute a fake in tests without bringing a real DOM into scope.
export interface EventSourceLike {
  addEventListener: (type: string, listener: (event: MessageEvent | Event) => void) => void;
  removeEventListener: (type: string, listener: (event: MessageEvent | Event) => void) => void;
  close: () => void;
  readyState: number;
}

const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export function useTickerEvents(opts: UseTickerEventsOpts = {}): UseTickerEventsResult {
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const url = opts.url ?? `${INDEXER_URL}/events`;
  const factory = opts.eventSourceFactory ?? defaultFactory;

  const [events, setEvents] = useState<TickerEvent[]>([]);
  const [status, setStatus] = useState<UseTickerEventsResult["status"]>("connecting");

  // We keep the seen-id set in a ref rather than state so dedupe checks don't
  // trigger renders. Bounded to ~2× maxEvents (we don't need to remember
  // every id we've ever seen, just enough to absorb retries / replay).
  const seenIds = useRef<Set<number>>(new Set());

  // Stash `factory` in a ref so an inline arrow at the call site doesn't
  // re-arm the effect on every render — the SSE connection would otherwise
  // tear down + reconnect each time the parent re-rendered. Same pattern as
  // `usePoll`'s fetcherRef. The effect's deps therefore cover only the
  // values that should genuinely retrigger a connect (url, backoff knobs,
  // max events).
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  useEffect(() => {
    let mounted = true;
    let es: EventSourceLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const onTicker = (raw: MessageEvent | Event): void => {
      // Named-event listeners receive MessageEvent in browsers; defensive cast
      // keeps both the test fake (plain object with `data`) and the real API happy.
      const data = (raw as MessageEvent).data;
      if (typeof data !== "string") return;
      let parsed: TickerEvent;
      try {
        parsed = JSON.parse(data) as TickerEvent;
      } catch {
        return;
      }
      if (typeof parsed.id !== "number") return;
      if (seenIds.current.has(parsed.id)) return;
      seenIds.current.add(parsed.id);
      // Cap the seen-set so it doesn't grow unbounded over a long-lived session.
      if (seenIds.current.size > maxEvents * 2) {
        const it = seenIds.current.values().next();
        if (!it.done) seenIds.current.delete(it.value);
      }
      if (!mounted) return;
      setEvents((prev) => {
        const next = [parsed, ...prev];
        return next.length > maxEvents ? next.slice(0, maxEvents) : next;
      });
    };

    const onOpen = (): void => {
      if (!mounted) return;
      attempts = 0;
      setStatus("open");
    };

    const onError = (): void => {
      if (!mounted) return;
      // Close the current source and schedule a backoff reconnect. We don't rely
      // on the browser's auto-reconnect because it ignores our cap and fires
      // bursts when the server is hard-down.
      try {
        es?.close();
      } catch {
        // ignore — best-effort teardown.
      }
      es = null;
      const delay = Math.min(initialBackoffMs * 2 ** attempts, maxBackoffMs);
      attempts++;
      setStatus("reconnecting");
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = (): void => {
      if (!mounted) return;
      setStatus(attempts === 0 ? "connecting" : "reconnecting");
      try {
        es = factoryRef.current(url);
      } catch (e) {
        // Constructor itself failed (rare — e.g. invalid URL). Treat as an error.
        onError();
        return;
      }
      es.addEventListener("ticker", onTicker);
      es.addEventListener("open", onOpen);
      es.addEventListener("error", onError);
    };

    connect();

    return () => {
      // Mark `closed` BEFORE flipping `mounted`. When the effect re-runs due
      // to a dep change (rather than unmount), this puts the hook briefly
      // into `closed` and the new effect run immediately drives it back to
      // `connecting` — keeps the transition consistent with the open/error
      // path. Every other setState in this hook is gated on `mounted`; this
      // one runs while still mounted by ordering.
      setStatus("closed");
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) {
        try {
          es.removeEventListener("ticker", onTicker);
          es.removeEventListener("open", onOpen);
          es.removeEventListener("error", onError);
          es.close();
        } catch {
          // ignore — teardown only.
        }
      }
    };
  }, [url, maxEvents, initialBackoffMs, maxBackoffMs]);

  return {events, status};
}

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}
