// Design tokens — mirrors the `B2` object in the design handoff (broadcast2.jsx).
// Keep hex values exact; the design is pixel-close.

export const C = {
  bg: "#0a0612",
  bg2: "#140828",
  panel: "#15091f",
  line: "rgba(255,255,255,0.08)",
  lineSoft: "rgba(255,255,255,0.04)",

  text: "#fef2ff",
  dim: "rgba(255,235,255,0.62)",
  faint: "rgba(255,235,255,0.32)",

  pink: "#ff3aa1",
  cyan: "#00f0ff",
  yellow: "#ffe933",
  green: "#52ff8b",
  red: "#ff2d55",
  purple: "#9c5cff",
} as const;

export const F = {
  display: '"Bricolage Grotesque", Archivo, ui-sans-serif, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

// Per-token avatar color — used for avatar bg, ticker-tape pip, finalist glow.
// Locked to ARENA_SPEC §3.2 — pinned by tickerColorsMap.test.ts so any drift
// surfaces as a regression. Audit H-Arena-1 (Phase 1, 2026-05-01) caught the
// pre-fix map silently re-themed every avatar away from the broadcast palette.
export const TICKER_COLORS = {
  FILTER: "#ff3aa1",
  BLOOD: "#ff2d55",
  KING: "#ffe933",
  SURVIVE: "#52ff8b",
  MOON: "#9c5cff",
  FINAL: "#00f0ff",
  CUT: "#ff8aa1",
  EDGE: "#ffaa3a",
  SLICE: "#aaff3a",
  RUG: "#ff5577",
  DUST: "#aa88ff",
  GHOST: "#88aacc",
} as const;

export function tickerColor(t: string): string {
  return (TICKER_COLORS as Record<string, string>)[t] ?? C.purple;
}

// Strip the `$` prefix from a ticker. The indexer hands us `$`-prefixed
// strings (`$FILTER`); some surfaces need the bare symbol — avatar
// `tickerColor` lookups, two-letter avatar glyphs, etc. Single source
// of truth so future changes to the prefix convention only touch one
// file (bugbot caught the prior duplication across components).
export function stripDollar(ticker: string): string {
  return ticker.startsWith("$") ? ticker.slice(1) : ticker;
}

// Top 6 survive each filter — drives leaderboard row split.
export const SURVIVE_COUNT = 6;
