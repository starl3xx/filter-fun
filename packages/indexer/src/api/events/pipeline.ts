/// Event pipeline — priority assignment, dedupe, throttle, suppression. Pure functions
/// against an explicit state object so vitest can drive the rules without a clock.
///
/// Per spec §36.1.4:
///
///   - **Priority** is HIGH / MEDIUM / LOW. (Pinned in `message.ts:priorityOf`.)
///   - **Dedupe** by `(token, type)` over a sliding window — collapses repeated signals
///     so $X dropping below the cut line three times in a minute fires once.
///   - **Throttle** per token — at most N events per token per window so one volatile
///     token doesn't dominate the feed.
///   - **Suppress LOW when HIGH/MEDIUM are queued** — if the current emit batch carries
///     any HIGH/MEDIUM event, drop all LOW events from this batch. Keeps the ticker
///     legible during dramatic moments without losing any LOW events that arrive on
///     subsequent ticks once things calm down.
///   - **Filter-moment suppression** — after a FILTER_FIRED event, suppress all non-filter
///     LOW + MEDIUM events for `filterMomentWindowMs`. Filter moments are the spec's
///     "announcement strip" mode (§20.8).
///
/// State management:
///   - `dedupeSeen` is a Map keyed by `${token}:${type}` whose value is the timestamp of
///     the last emission. Lookups + inserts are O(1); a periodic prune (every call) drops
///     entries older than `dedupeWindowMs`.
///   - `throttleCounts` is keyed by token address; value is an array of timestamps within
///     the throttle window. Pruned on each call.
///   - `filterMomentEndsAt` is the wall-clock ms when a filter-moment suppression window
///     expires. Set whenever a FILTER_FIRED comes through.

import type {EventsConfig} from "./config.js";
import {priorityOf, renderEvent, type RendererClock} from "./message.js";
import type {DetectedEvent, TickerEvent} from "./types.js";

export interface PipelineState {
  /// Last emission time per `(token|"")_${type}` key.
  dedupeSeen: Map<string, number>;
  /// Timestamps of events emitted per token within the throttle window.
  throttleCounts: Map<string, number[]>;
  /// Wall-clock ms at which the filter-moment suppression window expires (0 = inactive).
  filterMomentEndsAt: number;
}

export function makeState(): PipelineState {
  return {
    dedupeSeen: new Map(),
    throttleCounts: new Map(),
    filterMomentEndsAt: 0,
  };
}

export interface PipelineClock extends RendererClock {
  /// Wall-clock ms — distinct from `now()` so tests can use cheap integer ms while still
  /// pinning the ISO/id pair via the renderer clock.
  nowMs: () => number;
}

export interface PipelineResult {
  emitted: TickerEvent[];
  /// Side info for tests / metrics: how many events each stage dropped.
  droppedByStage: {dedupe: number; throttle: number; suppressLow: number; filterMoment: number};
}

/// Process a single tick's worth of detected events. Mutates `state` in place — caller
/// keeps state across ticks. Returns the wire events to broadcast plus per-stage drop
/// counts.
export function runPipeline(
  detected: ReadonlyArray<DetectedEvent>,
  state: PipelineState,
  cfg: EventsConfig,
  clock: PipelineClock,
): PipelineResult {
  const nowMs = clock.nowMs();
  pruneDedupe(state, nowMs, cfg.dedupeWindowMs);
  pruneThrottle(state, nowMs, cfg.throttleWindowMs);

  const dropped = {dedupe: 0, throttle: 0, suppressLow: 0, filterMoment: 0};

  // Stage 1 — dedupe + throttle + filter-moment. We keep events as `{event, priority}`
  // pairs so stage 2 (low-suppress) can scan once.
  const survivors: {d: DetectedEvent; priority: ReturnType<typeof priorityOf>}[] = [];
  for (const d of detected) {
    const priority = priorityOf(d);
    const tokenKey = d.token?.address.toLowerCase() ?? ""; // "" for system events
    const dedupeKey = `${tokenKey}_${d.type}`;

    // Dedupe.
    const prevSeen = state.dedupeSeen.get(dedupeKey);
    if (prevSeen !== undefined && nowMs - prevSeen < cfg.dedupeWindowMs) {
      dropped.dedupe++;
      continue;
    }

    // Throttle (token-scoped only — system events are exempt).
    if (tokenKey !== "") {
      const stamps = state.throttleCounts.get(tokenKey) ?? [];
      if (stamps.length >= cfg.throttlePerTokenMax) {
        dropped.throttle++;
        continue;
      }
    }

    // Filter-moment suppression — drops only LOW/MEDIUM non-filter events. HIGH-priority
    // signals (e.g. a CUT_LINE_CROSSED that fires *during* the filter window) must always
    // reach clients; the spec is unambiguous that HIGH events are never silently discarded.
    if (
      state.filterMomentEndsAt > 0 &&
      nowMs < state.filterMomentEndsAt &&
      d.type !== "FILTER_FIRED" &&
      d.type !== "FILTER_COUNTDOWN" &&
      priority !== "HIGH"
    ) {
      dropped.filterMoment++;
      continue;
    }

    // FILTER_FIRED arms the filter-moment window.
    if (d.type === "FILTER_FIRED") {
      state.filterMomentEndsAt = nowMs + cfg.filterMomentWindowMs;
    }

    survivors.push({d, priority});
  }

  // Stage 2 — LOW suppression: if the surviving batch carries any HIGH or MEDIUM event,
  // drop all LOWs. Per spec §36.1.4: LOW-priority events are dropped when HIGH or MEDIUM
  // events are queued.
  const hasHigherPriority = survivors.some(
    (s) => s.priority === "HIGH" || s.priority === "MEDIUM",
  );
  const finalSurvivors = hasHigherPriority
    ? survivors.filter((s) => {
        if (s.priority === "LOW") {
          dropped.suppressLow++;
          return false;
        }
        return true;
      })
    : survivors;

  // Stage 3 — record state for survivors. Done after stage 2 so suppressed LOWs don't
  // count against throttle or dedupe (otherwise a noisy LOW-only token could exhaust its
  // throttle slots without ever reaching a client).
  const emitted: TickerEvent[] = [];
  for (const {d} of finalSurvivors) {
    const tokenKey = d.token?.address.toLowerCase() ?? "";
    const dedupeKey = `${tokenKey}_${d.type}`;
    state.dedupeSeen.set(dedupeKey, nowMs);
    if (tokenKey !== "") {
      const stamps = state.throttleCounts.get(tokenKey) ?? [];
      stamps.push(nowMs);
      state.throttleCounts.set(tokenKey, stamps);
    }
    emitted.push(renderEvent(d, clock));
  }

  return {emitted, droppedByStage: dropped};
}

function pruneDedupe(state: PipelineState, nowMs: number, windowMs: number): void {
  for (const [k, v] of state.dedupeSeen) {
    if (nowMs - v >= windowMs) state.dedupeSeen.delete(k);
  }
}

function pruneThrottle(state: PipelineState, nowMs: number, windowMs: number): void {
  for (const [k, stamps] of state.throttleCounts) {
    const kept = stamps.filter((s) => nowMs - s < windowMs);
    if (kept.length === 0) state.throttleCounts.delete(k);
    else state.throttleCounts.set(k, kept);
  }
}
