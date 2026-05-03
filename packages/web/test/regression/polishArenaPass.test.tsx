/// PolishArenaPassTest — Audit polish pass (Phase 1, 2026-05-02)
///
/// Bundled regressions for the code-touching items in the arena polish PR.
/// Each test maps to one finding in audit/2026-05-PHASE-1-AUDIT/arena.md so a
/// future revert that drops the change surfaces with the audit ID in the
/// failure label, not just an opaque assertion miss.
///
/// Findings covered (CODE only — DOC / CLOSE-INCIDENTAL / CLOSE-AS-PASS rows
/// are pinned by the status notes in arena.md, not by this suite):
///   - M-Arena-1 + M-Arena-8 + L-Arena-3: COL_TEMPLATE re-aligned to
///     ARENA_SPEC §6.4.2 + 24 px chevron column added (9-col variant).
///   - M-Arena-2: EVENT_TYPE_STYLES map renders icon + colour per event.
///   - M-Arena-3: Activity feed header carries 📡 icon + STREAMING pill.
///   - M-Arena-6: ArenaTopBar Stat value font size = 14 (was 16; spec T7).
///   - L-Arena-1: row opacity ramps to 0.5 only at indices 10-11 (ranks
///     11-12); ranks 7-10 stay at full opacity.
///   - L-Arena-4: ArenaTopBar gap = 22 (was 12).
///   - L-Arena-5: ArenaTopBar padding = "0 22px" + min-height 56 (was
///     "12px 18px" with no explicit min-height).
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaActivityFeed} from "../../src/components/arena/ArenaActivityFeed.js";
import type {TickerEvent} from "../../src/lib/arena/api.js";
import {C} from "../../src/lib/tokens.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
function readSource(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf-8");
}

// M-Arena-1 + M-Arena-8 + L-Arena-3 -----------------------------------------
//
// Pre-fix: COL_TEMPLATE was "32px 30px minmax(0, 1fr) 116px 92px 84px 78px
// 74px" — an 8-column shape that drifted from the spec across every column
// and omitted the 8th-position chevron entirely. Post-fix: 9-column variant
// re-aligned to spec where reasonable + Trend column kept (intentional
// addition) + 24 px chevron column added.
describe("M-Arena-1 + M-Arena-8 + L-Arena-3: leaderboard COL_TEMPLATE + chevron column", () => {
  const src = readSource("src/components/arena/ArenaLeaderboard.tsx");

  it("COL_TEMPLATE matches the spec-aligned 9-column shape", () => {
    expect(src).toMatch(
      /COL_TEMPLATE\s*=\s*"34px 28px minmax\(0, 1fr\) 86px 84px 70px 96px 60px 24px"/,
    );
  });

  it("ColumnHeader renders 9 cells (8 labelled + 1 blank chevron header)", () => {
    // Capture the ColumnHeader function body and count the immediate <div>
    // children. Source-grep is sufficient here because the spec change is
    // structural — the chevron cell is empty by design.
    const m = src.match(/function ColumnHeader\(\)\s*\{[\s\S]*?return\s*\(([\s\S]*?)\n\s*\)\s*;/);
    expect(m).not.toBeNull();
    const headerJsx = m?.[1] ?? "";
    // The 9 cells are top-level <div> opens within the header grid.
    const divOpens = (headerJsx.match(/<div[\s>]/g) ?? []).length;
    // First match is the wrapping grid <div>; the rest are cells.
    expect(divOpens - 1).toBe(9);
  });

  it("Row body renders the chevron span as the 9th cell, after MiniSpark", () => {
    // The chevron span is wrapped in JSX with `›` and aria-hidden; it sits
    // after the trend column's MiniSpark. Pin both shape + ordering. The
    // upper bound between MiniSpark and aria-hidden was bumped from 500
    // → 900 chars to absorb the M-Brand-1 doc extension to the L-Arena-3
    // chevron comment block (Polish 6).
    expect(src).toMatch(/MiniSpark[\s\S]{0,900}aria-hidden[\s\S]{0,400}›/);
  });

  it("chevron colour reflects selection state (pink when selected, faint otherwise)", () => {
    expect(src).toMatch(/color:\s*isSelected\s*\?\s*C\.pink\s*:\s*C\.faint/);
  });
});

// M-Arena-2 -----------------------------------------------------------------
//
// Pre-fix: activity feed only colour-coded by priority bucket (HIGH/MEDIUM/
// LOW), losing per-event-type signal. Post-fix: EVENT_TYPE_STYLES map keyed
// by EventType supplies icon + colour per row.
describe("M-Arena-2: activity feed renders per-event-type icon + colour", () => {
  const mkEvent = (type: TickerEvent["type"], priority: TickerEvent["priority"]): TickerEvent => ({
    id: 1,
    type,
    priority,
    token: "$FILTER",
    address: "0x0000000000000000000000000000000000000001",
    message: `${type} test event`,
    data: {},
    timestamp: "2026-05-02T12:00:00.000Z",
  });

  it("HP_SPIKE renders the 📈 icon in green", () => {
    const {container} = render(<ArenaActivityFeed events={[mkEvent("HP_SPIKE", "HIGH")]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("📈");
    // Colour assertion via inline-style attribute on the message span.
    const messageSpan = container.querySelector("li span:last-child") as HTMLElement | null;
    expect(messageSpan?.style.color).toBe("rgb(82, 255, 139)"); // C.green
  });

  it("FILTER_FIRED renders the ▼ icon in red", () => {
    const {container} = render(<ArenaActivityFeed events={[mkEvent("FILTER_FIRED", "HIGH")]} />);
    expect(container.textContent ?? "").toContain("▼");
    const messageSpan = container.querySelector("li span:last-child") as HTMLElement | null;
    expect(messageSpan?.style.color).toBe("rgb(255, 45, 85)"); // C.red
  });

  it("VOLUME_SPIKE and LARGE_TRADE both render the 🐋 icon in purple (whale family)", () => {
    const events = [
      mkEvent("VOLUME_SPIKE", "MEDIUM"),
      {...mkEvent("LARGE_TRADE", "MEDIUM"), id: 2},
    ];
    const {container} = render(<ArenaActivityFeed events={events} />);
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(2);
    items.forEach((li) => {
      expect(li.textContent ?? "").toContain("🐋");
      const messageSpan = li.querySelector("span:last-child") as HTMLElement | null;
      expect(messageSpan?.style.color).toBe("rgb(156, 92, 255)"); // C.purple
    });
  });
});

// M-Arena-3 -----------------------------------------------------------------
//
// Pre-fix: header showed "Activity" + "Recent · N" only. Post-fix: 📡 icon
// next to title + STREAMING pill (with pulsing dot when liveStatus="open").
describe("M-Arena-3: activity feed header carries 📡 + STREAMING pill", () => {
  it("header includes the 📡 antenna icon next to the title", () => {
    const {container} = render(<ArenaActivityFeed events={[]} liveStatus="open" />);
    const heading = container.querySelector("h2");
    expect(heading?.textContent ?? "").toContain("📡");
    expect(heading?.textContent ?? "").toContain("Activity");
  });

  it("STREAMING pill renders with green dot when liveStatus=open", () => {
    const {container} = render(<ArenaActivityFeed events={[]} liveStatus="open" />);
    const pill = container.querySelector("[data-pill='streaming']") as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.textContent ?? "").toContain("STREAMING");
    // Pill text colour is C.green when open.
    expect(pill?.style.color).toBe("rgb(82, 255, 139)");
  });

  it("pill swaps to RECONNECTING / OFFLINE label and yellow / faint colour for non-open states", () => {
    const reconCase = render(<ArenaActivityFeed events={[]} liveStatus="reconnecting" />);
    const reconPill = reconCase.container.querySelector("[data-pill='streaming']") as HTMLElement | null;
    expect(reconPill?.textContent ?? "").toContain("RECONNECTING");
    expect(reconPill?.style.color).toBe("rgb(255, 233, 51)"); // C.yellow

    const offlineCase = render(<ArenaActivityFeed events={[]} liveStatus="closed" />);
    const offlinePill = offlineCase.container.querySelector("[data-pill='streaming']") as HTMLElement | null;
    expect(offlinePill?.textContent ?? "").toContain("OFFLINE");
    // C.faint = rgba(255,235,255,0.32) — jsdom serialises it as `rgba(...)`.
    expect(offlinePill?.style.color).toBe("rgba(255, 235, 255, 0.32)");
  });

  // Bugbot follow-up on PR #73: pre-fix the StreamingPill computed bg/border
  // via `${color}1f` / `${color}66`. That hex-suffix trick fails for the
  // OFFLINE state because `C.faint` is `rgba(...)` not `#hex` — appending
  // `1f` to an rgba string produces invalid CSS (`rgba(...,0.32)1f`),
  // which the browser silently drops. The OFFLINE pill rendered without
  // bg or border. Post-fix: `withAlpha(color, alpha)` handles both forms.
  it("bugbot fix: OFFLINE pill renders a valid rgba background + border (no invalid `rgba(...)1f`)", () => {
    const {container} = render(<ArenaActivityFeed events={[]} liveStatus="closed" />);
    const pill = container.querySelector("[data-pill='streaming']") as HTMLElement | null;
    expect(pill).not.toBeNull();
    // Both bg + border should resolve to valid `rgba(...)` values, NOT
    // contain the literal `1f` / `66` hex-suffix garbage.
    const bg = pill?.style.background ?? "";
    const border = pill?.style.border ?? "";
    expect(bg).toMatch(/^rgba\(/);
    expect(border).toMatch(/rgba\(/);
    expect(bg).not.toMatch(/\)1f/);
    expect(border).not.toMatch(/\)66/);
  });

  it("bugbot fix: OPEN pill (hex C.green) still renders the `#hex+1f`-shape result via withAlpha", () => {
    const {container} = render(<ArenaActivityFeed events={[]} liveStatus="open" />);
    const pill = container.querySelector("[data-pill='streaming']") as HTMLElement | null;
    expect(pill).not.toBeNull();
    // C.green = #52ff8b → withAlpha(C.green, 0.12) → #52ff8b1f (jsdom
    // normalises to lower-case rgba). Either form is browser-valid; just
    // assert the pill HAS a non-empty background that's a valid colour.
    expect(pill?.style.background).not.toBe("");
    expect(pill?.style.border).not.toBe("");
  });

  it("header still surfaces the items count for situational awareness", () => {
    const events = Array.from({length: 5}, (_, i) => ({
      id: i,
      type: "RANK_CHANGED" as const,
      priority: "LOW" as const,
      token: "$FILTER",
      address: "0x0000000000000000000000000000000000000001" as const,
      message: `rank changed ${i}`,
      data: {},
      timestamp: "2026-05-02T12:00:00.000Z",
    }));
    const {container} = render(<ArenaActivityFeed events={events} liveStatus="open" />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/5/);
  });
});

// M-Arena-6 -----------------------------------------------------------------
//
// Pre-fix: ArenaTopBar Stat values rendered at 16 px; ARENA_SPEC §2.3 (T7)
// calls for 14. Source-grep on the inline style — the alternative (mounting
// ArenaTopBar with computed-style assertions) would need a heavy harness for
// a one-token regression.
describe("M-Arena-6: ArenaTopBar Stat value font size is 14 (spec T7)", () => {
  const src = readSource("src/components/arena/ArenaTopBar.tsx");

  it("Stat value style declares fontSize: 14", () => {
    // Capture the Stat function's value-span style block (the second style
    // object, after the label one) and assert the fontSize.
    expect(src).toMatch(/fontSize:\s*14[\s\S]{0,200}fontVariantNumeric:\s*"tabular-nums"/);
  });

  it("the pre-fix fontSize: 16 is no longer present in the value-span block", () => {
    // The value-span block is the only place fontSize: 16 lived; pin the absence.
    // The Brand wordmark uses fontSize: 16 too — exclude that match by checking
    // the proximity to fontVariantNumeric (only the Stat value span has both).
    expect(src).not.toMatch(/fontSize:\s*16[\s\S]{0,200}fontVariantNumeric:\s*"tabular-nums"/);
  });
});

// L-Arena-1 -----------------------------------------------------------------
//
// Pre-fix: every row below the cut (indices 6-11) rendered at opacity 0.62.
// Post-fix: only indices 10-11 (ranks 11-12) get 0.5; ranks 7-10 stay at
// full opacity.
describe("L-Arena-1: leaderboard row opacity ramp matches ARENA_SPEC §3.3", () => {
  const src = readSource("src/components/arena/ArenaLeaderboard.tsx");

  it("rowOpacity uses index >= 10 ? 0.5 : 1 for the non-firing path", () => {
    expect(src).toMatch(/rowOpacity\s*=\s*firingMode && filtered \? 0\.42 : index >= 10 \? 0\.5 : 1/);
  });

  it("the pre-fix `below ? 0.62 : 1` is no longer present", () => {
    expect(src).not.toMatch(/below \? 0\.62 : 1/);
  });
});

// L-Arena-4 + L-Arena-5 -----------------------------------------------------
//
// Pre-fix: ArenaTopBar gap was 12, padding "12px 18px", no explicit
// min-height. Post-fix: gap 22, padding "0 22px", min-height 56 — matches
// ARENA_SPEC §6.1.
describe("L-Arena-4 + L-Arena-5: ArenaTopBar layout matches ARENA_SPEC §6.1", () => {
  const src = readSource("src/components/arena/ArenaTopBar.tsx");

  it("header gap is 22 (was 12)", () => {
    expect(src).toMatch(/gap:\s*22/);
  });

  it("header padding is \"0 22px\" (was \"12px 18px\")", () => {
    expect(src).toMatch(/padding:\s*"0 22px"/);
    expect(src).not.toMatch(/padding:\s*"12px 18px"/);
  });

  it("header carries explicit min-height: 56", () => {
    expect(src).toMatch(/minHeight:\s*56/);
  });
});

// Belt: a smoke render confirming the C palette is unchanged so the
// rgb-string assertions above stay stable across token-table edits. If
// future colour drift breaks these tests, this case fails first with the
// rejected hex value in the message instead of an opaque rgb() mismatch.
describe("Polish 4 belt: C palette spot-checks for the colour assertions above", () => {
  it("C.green / C.red / C.purple / C.yellow / C.faint match the values the rgb assertions expect", () => {
    expect(C.green).toBe("#52ff8b");
    expect(C.red).toBe("#ff2d55");
    expect(C.purple).toBe("#9c5cff");
    expect(C.yellow).toBe("#ffe933");
    expect(C.faint).toBe("rgba(255,235,255,0.32)");
  });
});
