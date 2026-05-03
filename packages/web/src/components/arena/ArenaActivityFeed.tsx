"use client";

/// Arena activity feed (spec §19.10).
///
/// Lower-fidelity peer to the ticker — the same `/events` stream rendered as
/// a stable chronological list (no animation, no marquee). Reuses the buffer
/// the ticker hook already maintains so we don't open a second SSE.

import type {EventType, TickerEvent} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

export type ArenaActivityFeedProps = {
  events: TickerEvent[];
  /// Cap rows shown — default 16. The full buffer can be longer (the
  /// ticker uses ~30 for marquee redundancy).
  max?: number;
  /// SSE status from useTickerEvents — drives the STREAMING pill colour
  /// (green when open, yellow while reconnecting, faint when offline).
  /// Optional — defaults to "open" so callers that don't have a live status
  /// (tests, storyboards) get the green-pill default visual.
  liveStatus?: "connecting" | "open" | "reconnecting" | "closed";
};

/// Audit M-Arena-2 (Phase 1, 2026-05-02): per-event-type icon + colour map.
/// ARENA_SPEC §6.6 enumerates 8 generic event types (enter / risk / pump /
/// whale / mission / launch / cross / lead) each paired with a glyph and a
/// broadcast-palette colour. The indexer emits 8 canonical EventType values
/// (`packages/indexer/src/api/events/types.ts`) which don't 1:1 with the
/// spec's generic names — this map is the join. Keyed by `EventType` so the
/// type system rejects future drops; ordered to match the indexer's
/// declaration order so a side-by-side review reads naturally.
///
/// Mapping rationale:
///   - RANK_CHANGED   → 🚀 cyan (rank movement = "enter" the visible part of the board)
///   - CUT_LINE_CROSSED → ⚠️ red ("cross" — the spec's exact glyph + colour pairing)
///   - HP_SPIKE       → 📈 green ("pump" — health rising fast)
///   - VOLUME_SPIKE   → 🐋 purple ("whale" — large-volume movement)
///   - LARGE_TRADE    → 🐋 purple (same family as VOLUME_SPIKE)
///   - FILTER_FIRED   → ▼ red ("risk" — terminal cut event)
///   - FILTER_COUNTDOWN → 🎯 yellow ("mission" — focused timer)
///   - PHASE_ADVANCED → ✨ pink ("launch" — new phase opens new opportunity)
const EVENT_TYPE_STYLES: Record<EventType, {icon: string; color: string}> = {
  RANK_CHANGED:      {icon: "🚀", color: C.cyan},
  CUT_LINE_CROSSED:  {icon: "⚠️",  color: C.red},
  HP_SPIKE:          {icon: "📈", color: C.green},
  VOLUME_SPIKE:      {icon: "🐋", color: C.purple},
  LARGE_TRADE:       {icon: "🐋", color: C.purple},
  FILTER_FIRED:      {icon: "▼",  color: C.red},
  FILTER_COUNTDOWN:  {icon: "🎯", color: C.yellow},
  PHASE_ADVANCED:    {icon: "✨", color: C.pink},
};

export function ArenaActivityFeed({events, max = 16, liveStatus = "open"}: ArenaActivityFeedProps) {
  const items = events.slice(0, max);
  return (
    <section
      aria-label="Activity feed"
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: 14,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${C.line}`,
        overflow: "hidden",
        minHeight: 0,
        flex: 1,
      }}
    >
      <div style={{padding: "10px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8}}>
        {/* Audit M-Arena-3 (Phase 1, 2026-05-02): ARENA_SPEC §6.6 calls for
            a 📡 antenna icon, the title, and a STREAMING pill (small green
            pulsing dot) in the header. Pre-fix only the title + a "Recent
            · N" count rendered, losing the "this is live" affordance. */}
        <h2 style={{margin: 0, fontFamily: F.display, fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", gap: 6}}>
          <span aria-hidden>📡</span> Activity
        </h2>
        <div style={{display: "flex", alignItems: "center", gap: 8}}>
          <StreamingPill liveStatus={liveStatus} />
          <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700, textTransform: "uppercase"}}>
            {items.length}
          </span>
        </div>
      </div>
      <ul className="ff-scroll" style={{margin: 0, padding: 0, listStyle: "none", flex: 1, overflow: "auto"}}>
        {items.length === 0 && (
          <li style={{padding: "16px", color: C.faint, fontSize: 11, fontFamily: F.mono, textAlign: "center"}}>
            No events yet — the next move will appear here.
          </li>
        )}
        {items.map((e) => {
          const style = EVENT_TYPE_STYLES[e.type];
          return (
            <li
              key={e.id}
              style={{
                padding: "8px 16px",
                borderBottom: `1px solid ${C.lineSoft}`,
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                fontSize: 12,
                fontFamily: F.mono,
                letterSpacing: "0.02em",
              }}
            >
              <span style={{color: C.faint, fontSize: 9, minWidth: 36, fontVariantNumeric: "tabular-nums"}}>{shortTime(e.timestamp)}</span>
              {/* Audit M-Arena-2: per-event-type icon + colour tile next to
                  the message. Falls back to the priority-driven colour if a
                  future EventType is added without updating EVENT_TYPE_STYLES
                  (defensive — the type system would normally catch this, but
                  the wire format could drift faster than the consumer.) */}
              <span aria-hidden style={{color: style?.color ?? priorityColor(e.priority), minWidth: 16, textAlign: "center"}}>
                {style?.icon ?? "·"}
              </span>
              {/* Color the message itself, not the <li> — earlier the priority color
                  was set on the <li> but both child <span>s overrode it with their
                  own `color`, so HIGH/LOW priority lines were visually identical. */}
              <span style={{flex: 1, color: style?.color ?? priorityColor(e.priority)}}>{e.message}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/// Audit M-Arena-3: small streaming-status pill mirroring the ArenaTopBar
/// LIVE pill pattern (same padding/alpha contract). Local rather than
/// imported so the activity feed component stays independent of the top-bar
/// component module.
///
/// Bugbot follow-up on PR #73: when liveStatus is "closed", `color` is
/// `C.faint` which is `rgba(255,235,255,0.32)` — NOT a hex string. Naively
/// appending `1f` / `66` to a `rgba(...)` value produces invalid CSS
/// (`rgba(...,0.32)1f`) which the browser drops, so the OFFLINE pill
/// rendered without bg/border. The local `withAlpha` helper below handles
/// both hex and rgba inputs correctly.
function StreamingPill({liveStatus}: {liveStatus: NonNullable<ArenaActivityFeedProps["liveStatus"]>}) {
  const color =
    liveStatus === "open" ? C.green : liveStatus === "closed" ? C.faint : C.yellow;
  const label =
    liveStatus === "open"
      ? "STREAMING"
      : liveStatus === "reconnecting"
        ? "RECONNECTING"
        : liveStatus === "closed"
          ? "OFFLINE"
          : "CONNECTING";
  return (
    <span
      data-pill="streaming"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 99,
        background: withAlpha(color, 0.12),
        border: `1px solid ${withAlpha(color, 0.4)}`,
        color,
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: 8,
        letterSpacing: "0.16em",
      }}
    >
      <span
        className={liveStatus === "open" ? "ff-pulse" : undefined}
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: 99,
          background: color,
          boxShadow: liveStatus === "open" ? `0 0 6px ${color}` : "none",
        }}
      />
      {label}
    </span>
  );
}

/// Bugbot follow-up on PR #73: returns `color` tinted with the given alpha,
/// handling BOTH hex (`#RRGGBB`) and rgba (`rgba(R, G, B, A)`) inputs. Pre-fix
/// StreamingPill used the hex-suffix shortcut (`${color}1f`) which produces
/// invalid CSS when the input is already an rgba string — the browser silently
/// drops invalid declarations, so the OFFLINE pill rendered without bg/border.
///
/// Why not use `color-mix(...)`? Wide browser support (Safari < 16.4 lacks it)
/// and our existing palette already uses both hex and rgba forms, so a
/// runtime helper is simpler than touching every consumer to switch palettes.
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
    return `${color}${a}`;
  }
  if (color.startsWith("rgba(")) {
    return color.replace(/,\s*[\d.]+\s*\)$/, `, ${alpha})`);
  }
  if (color.startsWith("rgb(")) {
    return color.replace(/^rgb\(/, "rgba(").replace(/\)$/, `, ${alpha})`);
  }
  return color;
}

function priorityColor(p: TickerEvent["priority"]): string {
  switch (p) {
    case "HIGH":
      return C.red;
    case "MEDIUM":
      return C.text;
    case "LOW":
      return C.dim;
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
