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
const TICKER_COLORS: Record<string, string> = {
  FILTER: "#ffe933",
  BLOOD: "#ff5d8c",
  KING: "#ffb020",
  SURVIVE: "#52ff8b",
  MOON: "#a78bfa",
  FINAL: "#00f0ff",
  CUT: "#ff7a4c",
  EDGE: "#fde047",
  SLICE: "#f472b6",
  RUG: "#9ca3af",
  DUST: "#78716c",
  GHOST: "#cbd5e1",
};

export function tickerColor(t: string): string {
  return TICKER_COLORS[t] ?? "#a78bfa";
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
