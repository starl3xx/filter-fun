/// State-machine tests for `useFilterMoment` (Epic 1.9 / spec §21).
///
/// Validates the four documented stage transitions against fixtures:
///   idle → countdown → firing → recap → done
///
/// Time is driven through the hook's `now` injection seam — no real timers,
/// no `vi.useFakeTimers()`. Each test instantiates the hook with `tickIntervalMs: 0`
/// so the internal interval doesn't fire; the test rerenders with a new
/// `now` factory to advance.

import {act, renderHook} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {useFilterMoment} from "@/hooks/arena/useFilterMoment";
import {makeFixtureEvent, makeFixtureSeason} from "../fixtures";

const NOW_BASE = new Date("2026-04-30T12:00:00Z");

function fakeNow(offsetMs: number): () => Date {
  return () => new Date(NOW_BASE.getTime() + offsetMs);
}

function isoDelta(ms: number): string {
  return new Date(NOW_BASE.getTime() + ms).toISOString();
}

describe("useFilterMoment", () => {
  it("returns idle when nextCutAt is far in the future and no events have fired", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(8 * 3600_000)});
    const {result} = renderHook(() =>
      useFilterMoment({season, events: [], now: fakeNow(0), tickIntervalMs: 0, simulate: false}),
    );
    expect(result.current.stage).toBe("idle");
    expect(result.current.isOverlayActive).toBe(false);
    expect(result.current.filteredAddresses.size).toBe(0);
  });

  it("transitions to countdown when nextCutAt enters the 10-minute window", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(5 * 60_000)});
    const {result} = renderHook(() =>
      useFilterMoment({season, events: [], now: fakeNow(0), tickIntervalMs: 0, simulate: false}),
    );
    expect(result.current.stage).toBe("countdown");
    expect(result.current.secondsUntilCut).toBe(300);
    expect(result.current.isOverlayActive).toBe(true);
  });

  it("transitions to countdown when a FILTER_COUNTDOWN event arrives in the last 60s", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(20 * 60_000)});
    const events = [makeFixtureEvent({type: "FILTER_COUNTDOWN", timestamp: isoDelta(-15_000)})];
    const {result} = renderHook(() =>
      useFilterMoment({season, events, now: fakeNow(0), tickIntervalMs: 0, simulate: false}),
    );
    expect(result.current.stage).toBe("countdown");
  });

  it("transitions to firing when FILTER_FIRED arrives, then to recap after 5s, then done after 35s", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(0)});
    const firedAddr = "0x000000000000000000000000000000000000000a" as `0x${string}`;
    const events = [
      makeFixtureEvent({
        id: 100,
        type: "FILTER_FIRED",
        address: firedAddr,
        data: {address: firedAddr},
        timestamp: isoDelta(0),
      }),
    ];

    // T = 0: firing stage with the filtered address surfaced.
    const {result, rerender} = renderHook(
      ({now}: {now: number}) =>
        useFilterMoment({season, events, now: fakeNow(now), tickIntervalMs: 0, simulate: false}),
      {initialProps: {now: 100}},
    );
    expect(result.current.stage).toBe("firing");
    expect(result.current.filteredAddresses.has(firedAddr.toLowerCase() as `0x${string}`)).toBe(true);

    // T = 5.5s: recap stage. The filtered set stays populated so the recap
    // card has the survivors / filtered split it needs.
    rerender({now: 5_500});
    expect(result.current.stage).toBe("recap");
    expect(result.current.filteredAddresses.size).toBe(1);

    // T = 36s: past the 5s firing + 30s recap auto-fade window. The hook's
    // auto-latch effect collapses straight to idle (the user-visible state
    // — the "done" stage is an internal transient that flips the
    // acknowledged-id latch). Overlay returns to idle / no-render.
    rerender({now: 36_000});
    expect(result.current.stage).toBe("idle");
    expect(result.current.acknowledgedFilterId).toBe(100);

    // T = 50s: latched — stays idle until a strictly newer FILTER_FIRED.
    rerender({now: 50_000});
    expect(result.current.stage).toBe("idle");
  });

  it("dismiss() collapses recap to done immediately and latches", () => {
    const firedAddr = "0x000000000000000000000000000000000000000b" as `0x${string}`;
    const events = [
      makeFixtureEvent({
        id: 200,
        type: "FILTER_FIRED",
        address: firedAddr,
        data: {address: firedAddr},
        timestamp: isoDelta(0),
      }),
    ];
    const {result, rerender} = renderHook(
      ({now}: {now: number}) =>
        useFilterMoment({
          season: makeFixtureSeason(),
          events,
          now: fakeNow(now),
          tickIntervalMs: 0,
          simulate: false,
        }),
      {initialProps: {now: 6_000}},
    );
    expect(result.current.stage).toBe("recap");

    act(() => {
      result.current.dismiss();
    });
    rerender({now: 6_100});
    expect(result.current.stage).toBe("idle");

    // A *newer* firing event re-arms the overlay.
    const newer = [
      ...events,
      makeFixtureEvent({
        id: 300,
        type: "FILTER_FIRED",
        address: firedAddr,
        data: {address: firedAddr},
        timestamp: isoDelta(60_000),
      }),
    ];
    const {result: result2} = renderHook(() =>
      useFilterMoment({
        season: makeFixtureSeason(),
        events: newer,
        now: fakeNow(60_500),
        tickIntervalMs: 0,
        simulate: false,
      }),
    );
    // A fresh hook instance with the newer events fires again.
    expect(result2.current.stage).toBe("firing");
  });

  it("simulation auto-fade reaches idle (regression: bugbot — does not lock at done)", () => {
    // Reported by bugbot on PR #49. In simulation mode, the auto-fade timer
    // would land on "done" but the done-latch effect only had a real-data
    // path (advance acknowledgedFilterId). With no filterFiredBatch, no
    // state changed and the next render's stage useMemo still returned
    // "done" — the overlay locked there forever instead of returning to
    // idle. Fix mirrors dismiss(): clear simStartRef + simulateActive.
    const season = makeFixtureSeason({nextCutAt: isoDelta(8 * 3600_000)});
    const {result, rerender} = renderHook(
      ({now}: {now: number}) =>
        useFilterMoment({season, events: [], now: fakeNow(now), tickIntervalMs: 0, simulate: true}),
      {initialProps: {now: 1_000}},
    );
    rerender({now: 5_000});
    expect(result.current.stage).toBe("countdown");
    rerender({now: 45_000});
    // Auto-fade ran past the 40s sim window. The done-latch effect must
    // have cleared simulation state so the next render reads idle.
    expect(result.current.stage).toBe("idle");
    rerender({now: 60_000});
    expect(result.current.stage).toBe("idle");
  });

  it("simulation mode walks countdown → firing → recap → done synthetically", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(8 * 3600_000)});
    const {result, rerender} = renderHook(
      ({now}: {now: number}) =>
        useFilterMoment({season, events: [], now: fakeNow(now), tickIntervalMs: 0, simulate: true}),
      {initialProps: {now: 1_000}},
    );
    // Before the simulation start ref is wired — first render mounts simulation.
    expect(["countdown", "idle"]).toContain(result.current.stage);

    // After the effect lands and `simStartRef` is set, t=8s should be in the
    // countdown phase (sim countdown window is 0–10s).
    rerender({now: 8_000});
    expect(result.current.stage).toBe("countdown");

    rerender({now: 12_000});
    expect(result.current.stage).toBe("firing");

    rerender({now: 18_000});
    expect(result.current.stage).toBe("recap");

    // Auto-fade past the 40s sim window. The done-latch effect clears
    // simulation state so the user-visible stage is idle (the "done" stage
    // is an internal transient — see the regression test above).
    rerender({now: 45_000});
    expect(result.current.stage).toBe("idle");
  });

  it("does not enter countdown during launch or settled phases", () => {
    const launchSeason = makeFixtureSeason({phase: "launch", nextCutAt: isoDelta(2 * 60_000)});
    const {result: r1} = renderHook(() =>
      useFilterMoment({season: launchSeason, events: [], now: fakeNow(0), tickIntervalMs: 0, simulate: false}),
    );
    expect(r1.current.stage).toBe("idle");

    const settledSeason = makeFixtureSeason({phase: "settled", nextCutAt: isoDelta(2 * 60_000)});
    const {result: r2} = renderHook(() =>
      useFilterMoment({season: settledSeason, events: [], now: fakeNow(0), tickIntervalMs: 0, simulate: false}),
    );
    expect(r2.current.stage).toBe("idle");
  });

  it("collapses multiple FILTER_FIRED events in a single tick into one stage", () => {
    // The indexer emits one FILTER_FIRED per filtered token. The hook should
    // anchor on the earliest timestamp + maximum id so the recap shows them
    // all together rather than cycling through stages.
    const season = makeFixtureSeason({nextCutAt: isoDelta(0)});
    const events = [
      makeFixtureEvent({
        id: 401,
        type: "FILTER_FIRED",
        address: "0x000000000000000000000000000000000000aaaa",
        data: {address: "0x000000000000000000000000000000000000aaaa"},
        timestamp: isoDelta(0),
      }),
      makeFixtureEvent({
        id: 402,
        type: "FILTER_FIRED",
        address: "0x000000000000000000000000000000000000bbbb",
        data: {address: "0x000000000000000000000000000000000000bbbb"},
        timestamp: isoDelta(0),
      }),
    ];
    const {result} = renderHook(() =>
      useFilterMoment({season, events, now: fakeNow(2_000), tickIntervalMs: 0, simulate: false}),
    );
    expect(result.current.stage).toBe("firing");
    expect(result.current.filteredAddresses.size).toBe(2);
  });
});
