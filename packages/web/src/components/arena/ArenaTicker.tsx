"use client";

/// Arena ticker (spec §20).
///
/// Subscribes to the indexer's `/events` stream via `useTickerEvents` (the
/// hook handles dedupe + reconnect). The server-side pipeline already
/// applies priority/dedupe/throttle/LOW-suppression (§36.1.4), so this
/// component is *purely visual*: scroll, color, state.
///
/// Five visual states (spec §20.8):
///
///   normal          — mixed feed, default scroll speed
///   high-activity   — denser feed → faster scroll, more saturated chips
///   pre-filter      — final 10 minutes before a cut → emphasize countdown
///   filter-moment   — `FILTER_FIRED` just landed → full-width announcement
///   post-filter     — short window after the filter-moment → recap items
///
/// Server-side filter-moment suppression keeps the actual stream sane during
/// dramatic moments; the client mirrors that visually. `FILTER_COUNTDOWN`
/// HIGH events also pull the visual into pre-filter mode without waiting on
/// the wall-clock.

import {useMemo} from "react";

import {Triangle} from "@/components/Triangle";
import type {SeasonResponse, TickerEvent} from "@/lib/arena/api";
import {fmtCutCountdown, isPreFilterWindow, secondsUntil} from "@/lib/arena/format";
import {C, F} from "@/lib/tokens";

export type TickerVisualState = "normal" | "high-activity" | "pre-filter" | "filter-moment" | "post-filter";

export type ArenaTickerProps = {
  events: TickerEvent[];
  season: SeasonResponse | null;
  /// Override for tests / Storybook — picks the visual state without running
  /// the rules. Production passes nothing and the state derives from inputs.
  forceState?: TickerVisualState;
  /// Override `now` for deterministic tests.
  now?: Date;
};

export function ArenaTicker({events, season, forceState, now}: ArenaTickerProps) {
  const state = forceState ?? deriveState(events, season, now ?? new Date());

  return (
    <div
      role="region"
      aria-label="Live event ticker"
      className={`ff-ticker ff-ticker--${state}`}
      data-state={state}
      style={{
        position: "relative",
        zIndex: 2,
        height: 40,
        background: state === "filter-moment" ? "linear-gradient(90deg, #2a050aee, #4a0a16ee, #2a050aee)" : "rgba(10, 4, 18, 0.78)",
        borderTop: `1px solid ${state === "filter-moment" ? C.red : C.line}`,
        borderBottom: `1px solid ${state === "filter-moment" ? C.red : C.line}`,
        boxShadow: state === "filter-moment" ? `0 0 24px ${C.red}88, inset 0 0 24px ${C.red}33` : `inset 0 0 14px rgba(0,0,0,0.4)`,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
      }}
    >
      {state === "filter-moment" ? (
        <FilterMomentStrip events={events} />
      ) : state === "pre-filter" ? (
        <PreFilterStrip events={events} season={season} now={now ?? new Date()} />
      ) : (
        <Marquee events={events} state={state} />
      )}
    </div>
  );
}

// ============================================================ State derivation

const FILTER_MOMENT_WINDOW_MS = 10_000;
const POST_FILTER_WINDOW_MS = 40_000;
const HIGH_ACTIVITY_WINDOW_MS = 30_000;
const HIGH_ACTIVITY_THRESHOLD = 5;

export function deriveState(
  events: TickerEvent[],
  season: SeasonResponse | null,
  now: Date,
): TickerVisualState {
  const lastFilterFired = events.find((e) => e.type === "FILTER_FIRED");
  if (lastFilterFired) {
    const ageMs = now.getTime() - new Date(lastFilterFired.timestamp).getTime();
    if (ageMs >= 0 && ageMs <= FILTER_MOMENT_WINDOW_MS) return "filter-moment";
    if (ageMs > FILTER_MOMENT_WINDOW_MS && ageMs <= POST_FILTER_WINDOW_MS) return "post-filter";
  }
  // Pre-filter: server-emitted FILTER_COUNTDOWN HIGH events take precedence
  // over wall-clock (covers cases where the server's clock differs slightly).
  const recentCountdown = events.find((e) => e.type === "FILTER_COUNTDOWN");
  if (recentCountdown) {
    const ageMs = now.getTime() - new Date(recentCountdown.timestamp).getTime();
    if (ageMs >= 0 && ageMs <= 60_000) return "pre-filter";
  }
  if (isPreFilterWindow(season, now)) return "pre-filter";
  // High-activity: count events within the last window. Counts only events
  // the server has emitted recently — server-side suppression already keeps
  // LOW spam out, so a high count here is a real signal of activity.
  const cutoff = now.getTime() - HIGH_ACTIVITY_WINDOW_MS;
  const recent = events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  if (recent.length >= HIGH_ACTIVITY_THRESHOLD) return "high-activity";
  return "normal";
}

// ============================================================ Marquee

function Marquee({events, state}: {events: TickerEvent[]; state: TickerVisualState}) {
  // Cap to the most recent 30 events for the loop. Duplicate them so the
  // CSS marquee can translateX(-50%) seamlessly.
  const items = useMemo(() => events.slice(0, 30), [events]);

  if (items.length === 0) {
    return (
      <div style={{padding: "0 18px", color: C.faint, fontSize: 12, fontFamily: F.mono, letterSpacing: "0.05em"}}>
        Waiting for the next move…
      </div>
    );
  }

  // Faster animation duration for high-activity / post-filter.
  const durationS = state === "high-activity" ? 35 : state === "post-filter" ? 45 : 60;

  return (
    <div
      className="ff-marquee ff-ticker__track"
      style={{
        display: "flex",
        whiteSpace: "nowrap",
        animationDuration: `${durationS}s`,
        willChange: "transform",
      }}
    >
      <TickerRow events={items} />
      <TickerRow events={items} aria-hidden />
    </div>
  );
}

function TickerRow({events, ...rest}: {events: TickerEvent[]} & Record<string, unknown>) {
  return (
    <div {...rest} style={{display: "flex", alignItems: "center", flexShrink: 0, paddingRight: 18}}>
      {events.map((e, i) => (
        <TickerChip key={`${e.id}-${i}`} event={e} />
      ))}
    </div>
  );
}

function TickerChip({event}: {event: TickerEvent}) {
  const color = colorFor(event);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "0 16px",
        height: 40,
        fontFamily: F.mono,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.02em",
        color,
        borderRight: `1px solid ${C.lineSoft}`,
      }}
    >
      <span aria-hidden style={{opacity: 0.6}}>·</span>
      <span>{event.message}</span>
    </span>
  );
}

function colorFor(event: TickerEvent): string {
  switch (event.type) {
    case "FILTER_FIRED":
    case "FILTER_COUNTDOWN":
      return C.red;
    case "CUT_LINE_CROSSED": {
      const dir = (event.data?.direction as string | undefined) ?? "below";
      return dir === "above" ? C.green : C.red;
    }
    case "HP_SPIKE": {
      const delta = Number(event.data?.hpDelta ?? 0);
      return delta >= 0 ? C.pink : C.faint;
    }
    case "VOLUME_SPIKE":
      return C.pink;
    case "LARGE_TRADE":
      return C.cyan;
    case "RANK_CHANGED": {
      const from = Number(event.data?.fromRank ?? 0);
      const to = Number(event.data?.toRank ?? 0);
      return to < from ? C.green : C.red;
    }
    case "PHASE_ADVANCED":
      return C.yellow;
    default:
      return C.dim;
  }
}

// ============================================================ Pre-filter

function PreFilterStrip({events, season, now}: {events: TickerEvent[]; season: SeasonResponse | null; now: Date}) {
  const secs = season ? Math.max(0, secondsUntil(season.nextCutAt, now)) : 0;
  // Show countdown + the most recent 5 events related to near-cut tokens.
  const nearCut = events
    .filter((e) => e.priority === "HIGH" || e.type === "HP_SPIKE" || e.type === "RANK_CHANGED")
    .slice(0, 5);
  return (
    <div style={{display: "flex", width: "100%", alignItems: "center", gap: 18, padding: "0 18px"}}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 12px",
          borderRadius: 99,
          background: `${C.red}1a`,
          border: `1px solid ${C.red}88`,
          color: C.red,
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: 11,
          letterSpacing: "0.18em",
          flexShrink: 0,
        }}
      >
        <Triangle size={10} inline />
        <span>FILTER IN {fmtCutCountdown(secs)}</span>
      </div>
      <div
        className="ff-marquee ff-ticker__track"
        style={{display: "flex", animationDuration: "55s", whiteSpace: "nowrap", flex: 1, minWidth: 0, overflow: "hidden"}}
      >
        <TickerRow events={nearCut} />
        <TickerRow events={nearCut} aria-hidden />
      </div>
    </div>
  );
}

// ============================================================ Filter-moment

function FilterMomentStrip({events}: {events: TickerEvent[]}) {
  const headline = events.find((e) => e.type === "FILTER_FIRED");
  // The headline is a string from the indexer SSE stream and may carry the
  // 🔻 emoji on the wire (chat-style notification — see Triangle.tsx). The
  // fallback string uses ▼ since this component-level constant doesn't
  // travel over the stream.
  const message = headline?.message ?? "▼ FILTER LIVE";
  return (
    <div
      className="ff-pulse"
      style={{
        flex: 1,
        textAlign: "center",
        fontFamily: F.display,
        fontWeight: 900,
        fontSize: 16,
        letterSpacing: "0.18em",
        color: C.red,
        textShadow: `0 0 18px ${C.red}aa`,
        textTransform: "uppercase",
      }}
    >
      {message}
    </div>
  );
}
