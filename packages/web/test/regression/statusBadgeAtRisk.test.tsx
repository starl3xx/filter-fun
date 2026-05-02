/// Audit H-Arena-3 (Phase 1, 2026-05-01) regression — AT_RISK badge red ▼ (U+25BC).
///
/// Pre-fix the AT_RISK case used `#ffa940` orange + ⚠️ emoji, which (a) broke
/// the colour-icon contract in ARENA_SPEC §3.3 and (b) duplicated a different
/// glyph from the AT RISK chip elsewhere in the leaderboard which already used
/// ▼. Pin both the colour and the exact U+25BC codepoint here so a regression
/// to the emoji 🔻 (U+1F53B) — which renders as a coloured photo character on
/// some platforms and collides with our red CSS colour — surfaces in CI.
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {StatusBadge} from "../../src/components/arena/StatusBadge.js";
import {C} from "../../src/lib/tokens.js";

describe("StatusBadge AT_RISK spec lock (Audit H-Arena-3)", () => {
  it("renders the literal ▼ Unicode glyph (U+25BC), not the 🔻 emoji", () => {
    render(<StatusBadge status="AT_RISK" />);
    const badge = screen.getByText(/at risk/i).closest("span");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("▼");
    // Defensive: the emoji 🔻 is U+1F53B and would also satisfy a substring
    // match for "▼" in some renderers — assert it's NOT present.
    expect(badge!.textContent).not.toContain("🔻");
  });

  it("uses C.red for both text and border tint (not the pre-fix orange #ffa940)", () => {
    render(<StatusBadge status="AT_RISK" />);
    const badge = screen.getByText(/at risk/i).closest("span") as HTMLElement;
    expect(badge.style.color).toBe(hexToRgb(C.red));
    expect(badge.style.color).not.toBe(hexToRgb("#ffa940"));
  });
});

/// jsdom normalises CSS color values to rgb() form. Convert spec hexes to the
/// rgb() string the browser would emit so equality holds.
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`hexToRgb: invalid ${hex}`);
  const [, r, g, b] = m;
  return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`;
}
