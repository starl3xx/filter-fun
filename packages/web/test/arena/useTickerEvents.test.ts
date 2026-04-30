/// Hook tests for `useTickerEvents`.
///
/// Asserts:
///   - Incoming `ticker` events with new ids land in the buffer
///   - Repeat ids are deduplicated by id
///   - On error the hook closes the source and reconnects with backoff
///   - Multiple sources may be created across reconnect cycles
///
/// The hook accepts an `eventSourceFactory` injection — tests pass a Fake
/// that exposes `simulateOpen` / `simulateMessage` / `simulateError`. No real
/// network, no real EventSource.

import {act, renderHook} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {useTickerEvents, type EventSourceLike} from "@/hooks/arena/useTickerEvents";
import type {TickerEvent} from "@/lib/arena/api";

class FakeEventSource implements EventSourceLike {
  readyState = 1;
  private listeners: Map<string, Set<(e: MessageEvent | Event) => void>> = new Map();
  closed = false;

  addEventListener(type: string, listener: (e: MessageEvent | Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (e: MessageEvent | Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  simulateOpen(): void {
    this.dispatch("open", new Event("open"));
  }

  simulateMessage(event: TickerEvent): void {
    this.dispatch("ticker", new MessageEvent("ticker", {data: JSON.stringify(event)}));
  }

  simulateError(): void {
    this.dispatch("error", new Event("error"));
  }

  private dispatch(type: string, event: Event): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of set) l(event);
  }
}

function makeEvent(over: Partial<TickerEvent> = {}): TickerEvent {
  return {
    id: 1,
    type: "RANK_CHANGED",
    priority: "MEDIUM",
    token: "$FILTER",
    address: "0x0000000000000000000000000000000000000001",
    message: "$FILTER ↑ rank 3 → 2",
    data: {fromRank: 3, toRank: 2},
    timestamp: new Date().toISOString(),
    ...over,
  };
}

describe("useTickerEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends new events and deduplicates by id", () => {
    const sources: FakeEventSource[] = [];
    const factory = (): EventSourceLike => {
      const fake = new FakeEventSource();
      sources.push(fake);
      return fake;
    };

    const {result} = renderHook(() =>
      useTickerEvents({eventSourceFactory: factory, url: "test://events"}),
    );

    const fake = sources[0]!;
    act(() => fake.simulateOpen());
    expect(result.current.status).toBe("open");

    act(() => fake.simulateMessage(makeEvent({id: 1, message: "first"})));
    act(() => fake.simulateMessage(makeEvent({id: 2, message: "second"})));
    expect(result.current.events.map((e) => e.id)).toEqual([2, 1]);

    // Duplicate id 1 — must be dropped.
    act(() => fake.simulateMessage(makeEvent({id: 1, message: "duplicate"})));
    expect(result.current.events.map((e) => e.id)).toEqual([2, 1]);
  });

  it("reconnects with exponential backoff on error", () => {
    const sources: FakeEventSource[] = [];
    const factory = (): EventSourceLike => {
      const fake = new FakeEventSource();
      sources.push(fake);
      return fake;
    };

    const {result} = renderHook(() =>
      useTickerEvents({
        eventSourceFactory: factory,
        url: "test://events",
        initialBackoffMs: 100,
        maxBackoffMs: 800,
      }),
    );

    expect(sources).toHaveLength(1);
    act(() => sources[0]!.simulateError());
    expect(sources[0]!.closed).toBe(true);
    expect(result.current.status).toBe("reconnecting");

    // First retry @ 100ms.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(sources).toHaveLength(2);

    // Error again — second retry @ 200ms.
    act(() => sources[1]!.simulateError());
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(sources).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(sources).toHaveLength(3);

    // Open success — backoff resets.
    act(() => sources[2]!.simulateOpen());
    expect(result.current.status).toBe("open");

    // After reset, an error should retry at the *initial* backoff again.
    act(() => sources[2]!.simulateError());
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(sources).toHaveLength(4);
  });

  it("caps backoff at maxBackoffMs", () => {
    const sources: FakeEventSource[] = [];
    const factory = (): EventSourceLike => {
      const fake = new FakeEventSource();
      sources.push(fake);
      return fake;
    };

    renderHook(() =>
      useTickerEvents({
        eventSourceFactory: factory,
        url: "test://events",
        initialBackoffMs: 100,
        maxBackoffMs: 250,
      }),
    );

    // Burn through backoffs: 100, 200, 250 (capped), 250…
    act(() => sources[0]!.simulateError());
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => sources[1]!.simulateError());
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => sources[2]!.simulateError());
    // Cap kicks in here — even though 100 * 2^2 = 400, max is 250.
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(sources).toHaveLength(3);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(sources).toHaveLength(4);
  });
});
