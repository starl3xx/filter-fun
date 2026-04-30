"use client";

/// Arena activity feed (spec §19.10).
///
/// Lower-fidelity peer to the ticker — the same `/events` stream rendered as
/// a stable chronological list (no animation, no marquee). Reuses the buffer
/// the ticker hook already maintains so we don't open a second SSE.

import type {TickerEvent} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

export type ArenaActivityFeedProps = {
  events: TickerEvent[];
  /// Cap rows shown — default 16. The full buffer can be longer (the
  /// ticker uses ~30 for marquee redundancy).
  max?: number;
};

export function ArenaActivityFeed({events, max = 16}: ArenaActivityFeedProps) {
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
      <div style={{padding: "10px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center"}}>
        <h2 style={{margin: 0, fontFamily: F.display, fontWeight: 800, fontSize: 13}}>Activity</h2>
        <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700, textTransform: "uppercase"}}>
          Recent · {items.length}
        </span>
      </div>
      <ul className="ff-scroll" style={{margin: 0, padding: 0, listStyle: "none", flex: 1, overflow: "auto"}}>
        {items.length === 0 && (
          <li style={{padding: "16px", color: C.faint, fontSize: 11, fontFamily: F.mono, textAlign: "center"}}>
            No events yet — the next move will appear here.
          </li>
        )}
        {items.map((e) => (
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
              color: priorityColor(e.priority),
              letterSpacing: "0.02em",
            }}
          >
            <span style={{color: C.faint, fontSize: 9, minWidth: 36, fontVariantNumeric: "tabular-nums"}}>{shortTime(e.timestamp)}</span>
            <span style={{flex: 1, color: C.text}}>{e.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
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
