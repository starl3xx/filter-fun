"use client";

/// State machine for the filter-moment overlay (spec §21).
///
/// The overlay is the broadcast spectacle at hour 96 — "the leaderboard
/// updates" turned into a shareable ceremony. This hook is the trigger
/// logic: it consumes `/season` (for the wall-clock anchor) and the
/// `/events` SSE buffer (for FILTER_COUNTDOWN + FILTER_FIRED), and
/// produces a single discriminated `stage` the overlay renders against.
///
/// Stages (spec §21.1–§21.4):
///
///   idle       → no overlay. Default. Leaderboard runs as usual.
///   countdown  → final 10 minutes before a cut. Backdrop dims, the
///                center clock counts down, near-cutline rows highlight.
///   firing     → FILTER_FIRED has arrived. Announcement strip + survivor
///                halo + filtered stamps for ~5s.
///   recap      → ~5s after firing began. Center card with survivors,
///                pool delta, and (if applicable) rollover entitlement.
///   done       → user dismissed the recap, OR the 30s auto-fade ran out.
///                Overlay is gone until a *newer* FILTER_FIRED arrives.
///
/// Determinism:
/// - `countdown` is gated on either `season.nextCutAt - now ≤ 10min` OR
///   a FILTER_COUNTDOWN event within the last 60s. Either signal alone
///   is enough — gives us the visual pre-roll without depending on the
///   indexer's clock matching ours exactly.
/// - `firing → recap` and `recap → done` are time-based off the first
///   FILTER_FIRED event the hook saw, so multiple FILTER_FIRED events
///   in the same tick (one per filtered token) don't restart the timer.
/// - The `done` stage *latches*: it stays done until a FILTER_FIRED with
///   an id strictly greater than `acknowledgedFilterId` arrives. Without
///   the latch the overlay would re-show every render until the firing
///   event aged out.
///
/// Dev simulation:
///   `?simulate=filter` (read once on mount) walks the stages
///   synthetically — countdown for ~10s, firing for 5s, recap for 25s,
///   done. Lets us validate the choreography without waiting for hour 96.
///
/// All wall-clock state lives on a 250ms tick so the countdown stays
/// responsive while transitions remain cheap.

import {useEffect, useMemo, useRef, useState} from "react";

import type {SeasonResponse, TickerEvent} from "@/lib/arena/api";

export type FilterMomentStage = "idle" | "countdown" | "firing" | "recap" | "done";

export type UseFilterMomentArgs = {
  season: SeasonResponse | null;
  events: TickerEvent[];
  /// Override for tests / Storybook — replaces `Date.now()`. Optional in
  /// production; the hook's internal tick keeps `now` fresh.
  now?: () => Date;
  /// Override the tick interval — tests pass `0` and drive `now` directly.
  tickIntervalMs?: number;
  /// Test seam: pre-set the simulate flag without going through `window`.
  simulate?: boolean;
};

export type UseFilterMomentResult = {
  stage: FilterMomentStage;
  /// Seconds remaining until `nextCutAt`. Negative once the cut has
  /// passed; null when there's no anchor (settled, pre-season, etc).
  /// Always present so the consumer can show a banner during recap.
  secondsUntilCut: number | null;
  /// FILTER_FIRED events the hook is currently dramatizing. Empty in
  /// idle / countdown. The recap card renders survivors as
  /// `cohort \ filteredAddresses`.
  filteredAddresses: Set<`0x${string}`>;
  /// Highest event id the hook has seen and "consumed" (acknowledged via
  /// the `dismiss` callback or the 30s auto-timeout). Exposed so the
  /// homepage's auto-select effects can stay coherent if they want it.
  acknowledgedFilterId: number | null;
  /// Imperative dismissal — collapses recap straight to done. Auto-fade
  /// timer still applies as a fallback.
  dismiss: () => void;
  /// True iff the overlay is currently obscuring the page (countdown,
  /// firing, recap). Convenience for parents that want to suppress
  /// other modals or pause polling.
  isOverlayActive: boolean;
};

const COUNTDOWN_WINDOW_SEC = 600; // 10 minutes — spec §21.2
const COUNTDOWN_EVENT_WINDOW_MS = 60_000; // FILTER_COUNTDOWN event must be ≤60s old
const FIRING_DURATION_MS = 5_000; // Stage 2 duration — spec §21.3 visual sequence
const RECAP_AUTO_FADE_MS = 30_000; // Recap auto-dismiss — spec §21.4 framing
const DEFAULT_TICK_MS = 250;

export function useFilterMoment(args: UseFilterMomentArgs): UseFilterMomentResult {
  const {season, events} = args;
  const tickIntervalMs = args.tickIntervalMs ?? DEFAULT_TICK_MS;

  // ?simulate=filter — read once on mount via window. Tests pass `simulate`
  // directly to avoid depending on a global. Read inside an effect so SSR
  // isn't perturbed.
  const [simulateActive, setSimulateActive] = useState(args.simulate ?? false);
  useEffect(() => {
    if (args.simulate !== undefined) return; // explicit override wins
    if (typeof window === "undefined") return;
    const v = new URLSearchParams(window.location.search).get("simulate");
    if (v === "filter") setSimulateActive(true);
  }, [args.simulate]);

  // Wall-clock — kept on a 250ms ticker so the countdown stays smooth and
  // stage transitions don't lag behind. The `now` factory is captured in a
  // ref so a fresh inline arrow at the call site doesn't re-arm the
  // interval every render. `nowMs` is read fresh from the factory each
  // render so manual rerenders in tests pick up the updated wall-clock
  // without going through state — the `tick` counter only exists to
  // schedule periodic re-renders in production.
  const nowFactoryRef = useRef(args.now ?? (() => new Date()));
  nowFactoryRef.current = args.now ?? (() => new Date());
  const [, setTick] = useState(0);
  useEffect(() => {
    if (tickIntervalMs <= 0) return; // tests drive their own re-renders
    const id = setInterval(() => setTick((n) => (n + 1) | 0), tickIntervalMs);
    return () => clearInterval(id);
  }, [tickIntervalMs]);
  const nowMs = nowFactoryRef.current().getTime();

  // Latched dismissal state. Tracks the highest FILTER_FIRED id we've
  // already shown the recap for. New firings (greater id) re-arm the
  // overlay; dismissal advances this to "everything currently buffered".
  const [acknowledgedFilterId, setAcknowledgedFilterId] = useState<number | null>(null);

  // The first time the firing stage entered — anchors the firing→recap
  // and recap→done timers. Reset to null on dismissal so a future
  // firing event starts fresh.
  const [firingStartedAtMs, setFiringStartedAtMs] = useState<number | null>(null);

  // ============================================================ Simulation

  // Simulation uses a synthetic "started at" timestamp; the real-data path
  // stays untouched.
  const [simStartedAtMs] = useState<number | null>(() => null);
  const simStartRef = useRef<number | null>(simStartedAtMs);
  useEffect(() => {
    if (!simulateActive) {
      simStartRef.current = null;
      return;
    }
    if (simStartRef.current === null) simStartRef.current = nowFactoryRef.current().getTime();
  }, [simulateActive]);

  // ============================================================ Real-data triggers

  // Most-recent FILTER_FIRED batch in the buffer, restricted to events the
  // hook hasn't already acknowledged. Multiple FILTER_FIRED events in the
  // same tick (one per filtered token) share approximately the same
  // timestamp; the anchor is the *latest* event's timestamp so that a
  // brand-new firing 60s after a dismissed one doesn't get pulled back to
  // the dismissed event's wall-clock. Addresses fold across the batch.
  const filterFiredBatch = useMemo(() => {
    const fired = events.filter((e) => {
      if (e.type !== "FILTER_FIRED") return false;
      if (acknowledgedFilterId !== null && e.id <= acknowledgedFilterId) return false;
      return true;
    });
    if (fired.length === 0) return null;
    const maxId = Math.max(...fired.map((e) => e.id));
    const maxTs = Math.max(...fired.map((e) => new Date(e.timestamp).getTime()));
    const addresses = new Set<`0x${string}`>();
    for (const e of fired) {
      const addr = e.address ?? (typeof e.data?.address === "string" ? (e.data.address as `0x${string}`) : null);
      if (addr) addresses.add(addr.toLowerCase() as `0x${string}`);
    }
    return {maxId, anchorTimestampMs: maxTs, addresses};
  }, [events, acknowledgedFilterId]);

  const filterCountdownEvent = useMemo(() => {
    return events.find((e) => e.type === "FILTER_COUNTDOWN") ?? null;
  }, [events]);

  // Anchor the firing-stage start once a fresh FILTER_FIRED batch arrives.
  useEffect(() => {
    if (simulateActive) return; // simulation drives its own clock
    if (!filterFiredBatch) return;
    setFiringStartedAtMs((prev) => prev ?? filterFiredBatch.anchorTimestampMs);
  }, [filterFiredBatch, simulateActive]);

  // ============================================================ Countdown derivation

  const secondsUntilCut = useMemo<number | null>(() => {
    if (!season) return null;
    if (season.phase === "settled" || season.phase === "launch") return null;
    const target = new Date(season.nextCutAt).getTime();
    if (!Number.isFinite(target)) return null;
    return Math.floor((target - nowMs) / 1000);
  }, [season, nowMs]);

  const recentCountdownEvent = useMemo(() => {
    if (!filterCountdownEvent) return false;
    const ts = new Date(filterCountdownEvent.timestamp).getTime();
    if (!Number.isFinite(ts)) return false;
    return nowMs - ts <= COUNTDOWN_EVENT_WINDOW_MS && nowMs - ts >= 0;
  }, [filterCountdownEvent, nowMs]);

  // ============================================================ Stage derivation

  const stage = useMemo<FilterMomentStage>(() => {
    // Simulation override — synthesizes the four-stage walk.
    if (simulateActive && simStartRef.current !== null) {
      const elapsed = nowMs - simStartRef.current;
      // Mirror real-stage durations so dev validates roughly what users see.
      // Countdown: 0–10s (compressed from 10min for dev), Firing: 10–15s,
      // Recap: 15–40s, Done: 40s+. These are dev-only — production stages
      // are gated on real signals.
      if (elapsed < 10_000) return "countdown";
      if (elapsed < 15_000) return "firing";
      if (elapsed < 40_000) return "recap";
      return "done";
    }

    // Done latches until a *newer* firing arrives. The batch already
    // filters out acknowledged events, so any non-null batch here is fresh.
    if (acknowledgedFilterId !== null && !filterFiredBatch) {
      return "idle";
    }

    if (firingStartedAtMs !== null) {
      const elapsed = nowMs - firingStartedAtMs;
      if (elapsed < FIRING_DURATION_MS) return "firing";
      if (elapsed < FIRING_DURATION_MS + RECAP_AUTO_FADE_MS) return "recap";
      // Recap auto-fade exhausted — fall through to done so the latch
      // arms on the next render.
      return "done";
    }

    // Pre-filter — either wall-clock or server signal.
    if (secondsUntilCut !== null && secondsUntilCut > 0 && secondsUntilCut <= COUNTDOWN_WINDOW_SEC) {
      return "countdown";
    }
    if (recentCountdownEvent) {
      return "countdown";
    }

    return "idle";
  }, [
    simulateActive,
    nowMs,
    acknowledgedFilterId,
    filterFiredBatch,
    firingStartedAtMs,
    secondsUntilCut,
    recentCountdownEvent,
  ]);

  // ============================================================ Done latch

  // When stage falls to "done" via the auto-fade path, latch acknowledgement
  // automatically so the next render reads "idle" instead of re-entering the
  // recap timer. Without this, the recap could oscillate at the boundary.
  //
  // Two paths land here: (1) real-data — `filterFiredBatch` is set, advance
  // `acknowledgedFilterId` to its max so the batch is filtered out next
  // render. (2) Simulation — there is no `filterFiredBatch`, so the latch
  // must instead clear `simStartRef` and `simulateActive` (mirroring
  // `dismiss()`); otherwise stage useMemo keeps returning "done" forever
  // because the simulation branch's `elapsed > 40_000` condition is still
  // satisfied. Bugbot caught this — without the simulation cleanup the
  // overlay locks at done after the auto-fade and never returns to idle.
  useEffect(() => {
    if (stage !== "done") return;
    if (filterFiredBatch && (acknowledgedFilterId === null || filterFiredBatch.maxId > acknowledgedFilterId)) {
      setAcknowledgedFilterId(filterFiredBatch.maxId);
    }
    setFiringStartedAtMs(null);
    if (simulateActive) {
      simStartRef.current = null;
      setSimulateActive(false);
    }
  }, [stage, filterFiredBatch, acknowledgedFilterId, simulateActive]);

  // ============================================================ Public API

  const filteredAddresses = useMemo<Set<`0x${string}`>>(() => {
    if (stage === "firing" || stage === "recap") {
      return filterFiredBatch?.addresses ?? new Set();
    }
    return new Set();
  }, [stage, filterFiredBatch]);

  const dismiss = (): void => {
    if (filterFiredBatch) {
      setAcknowledgedFilterId(filterFiredBatch.maxId);
    }
    setFiringStartedAtMs(null);
    if (simulateActive) {
      simStartRef.current = null;
      setSimulateActive(false);
    }
  };

  return {
    stage,
    secondsUntilCut,
    filteredAddresses,
    acknowledgedFilterId,
    dismiss,
    isOverlayActive: stage === "countdown" || stage === "firing" || stage === "recap",
  };
}
