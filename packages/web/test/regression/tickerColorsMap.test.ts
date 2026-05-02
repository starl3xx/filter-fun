/// Audit H-Arena-1 (Phase 1, 2026-05-01) regression — TICKER_COLORS spec lock.
///
/// Pre-fix the map silently re-themed every avatar away from the broadcast palette
/// (FILTER yellow, BLOOD pink, KING orange, MOON lavender, etc.). The spec map in
/// ARENA_SPEC §3.2 is the source of truth — pin it here so any future drift fails
/// in CI rather than landing as a visible regression in the leaderboard avatars,
/// ticker-tape pips, and finalist halos.
import {describe, expect, it} from "vitest";

import {TICKER_COLORS, tickerColor} from "../../src/lib/tokens.js";

describe("TICKER_COLORS spec lock (Audit H-Arena-1)", () => {
  it("matches ARENA_SPEC §3.2 verbatim (12 entries, exact hex)", () => {
    expect(TICKER_COLORS).toEqual({
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
    });
  });

  it("tickerColor() resolves a known ticker to its spec hex", () => {
    expect(tickerColor("FILTER")).toBe("#ff3aa1");
    expect(tickerColor("MOON")).toBe("#9c5cff");
  });

  it("tickerColor() falls back to purple for an unknown ticker (not white/black)", () => {
    expect(tickerColor("UNKNOWN_TICKER")).toBe("#9c5cff");
  });
});
