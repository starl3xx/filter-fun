/// Audit H-A11y-2 (Phase 1, 2026-05-01) regression — StatusBadge icon contract.
///
/// ARENA_SPEC §12: "Status pills carry both color and icon, never color alone."
/// Pre-fix the SAFE case returned `icon: null` and the rendering code wrapped
/// the icon span in `icon ? <span>…</span> : null`, so the SAFE pill conveyed
/// status by green colour alone — failing for colour-blind users (every other
/// green-tinted UI element looks the same).
///
/// Lock both halves of the fix:
///   1. SAFE returns the U+2713 CHECK MARK glyph (✓), not null
///   2. The icon span renders unconditionally — every status emits a
///      `<span aria-hidden>` with the glyph as its first child
///
/// AT_RISK is double-pinned (also tested in `statusBadgeAtRisk.test.tsx` from
/// Audit H-Arena-3) — keeping the assertion here so the four-status contract is
/// readable in one place.
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {StatusBadge} from "../../src/components/arena/StatusBadge.js";

const STATUS_ICON_CONTRACT = [
  {status: "FINALIST", labelMatch: /finalist/i, icon: "🏆"},
  {status: "SAFE", labelMatch: /safe/i, icon: "✓"},
  {status: "AT_RISK", labelMatch: /at risk/i, icon: "▼"},
  {status: "FILTERED", labelMatch: /filtered/i, icon: "▼"},
] as const;

describe("StatusBadge icon contract (Audit H-A11y-2)", () => {
  it("SAFE renders the ✓ (U+2713) glyph, not null/empty", () => {
    render(<StatusBadge status="SAFE" />);
    const badge = screen.getByText(/safe/i).closest("span") as HTMLElement;
    expect(badge.textContent).toContain("✓");
    // Defensive: U+2713 CHECK MARK, not the U+2714 HEAVY CHECK MARK or the
    // emoji ✅ (U+2705) which renders as a coloured photo character on some
    // platforms and would collide with the green CSS colour the same way the
    // 🔻/▼ swap caused trouble in H-Arena-3.
    expect(badge.textContent).not.toContain("✅");
    expect(badge.textContent).not.toContain("✔");
    // U+2713 specifically — codepoint 0x2713
    const found = Array.from(badge.textContent ?? "").some((c) => c.codePointAt(0) === 0x2713);
    expect(found).toBe(true);
  });

  it.each(STATUS_ICON_CONTRACT)("$status renders icon $icon unconditionally", ({status, labelMatch, icon}) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByText(labelMatch).closest("span") as HTMLElement;
    expect(badge).not.toBeNull();
    // First child must be the icon span (aria-hidden) — no conditional wrap.
    const firstChild = badge.firstElementChild as HTMLElement | null;
    expect(firstChild, `${status}: icon span not rendered`).not.toBeNull();
    expect(firstChild!.tagName).toBe("SPAN");
    expect(firstChild!.getAttribute("aria-hidden")).toBe("true");
    expect(firstChild!.textContent).toBe(icon);
  });

  it("every status pill has at least one DOM-rendered icon (no `icon && <span/>` regression)", () => {
    // Catches a regression where someone reintroduces a conditional render of
    // the icon span. We test this independently of icon glyph identity — even
    // if the glyphs change, the structural contract (always-render a span)
    // must hold.
    for (const {status} of STATUS_ICON_CONTRACT) {
      const {container, unmount} = render(<StatusBadge status={status} />);
      const spans = container.querySelectorAll("span[aria-hidden]");
      expect(spans.length, `${status}: expected at least one aria-hidden icon span`).toBeGreaterThanOrEqual(1);
      unmount();
    }
  });
});
