/// Activity feed direction-aware styling — Epic 1.28.
///
/// `RANK_CHANGED` and `HP_SPIKE` carry direction in the event payload.
/// Pre-Epic-1.28 they each rendered with a single static icon/colour,
/// losing the BUY/RANK_UP/LIQUIDITY_UP vs SELL/RANK_DOWN/RETENTION_DROP
/// pairing the spec §6.6 activity-feed table calls for. `styleFor()` now
/// resolves direction at render time. Tests here pin the mapping so a
/// regression to the static pre-fix shape surfaces in CI.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaActivityFeed, styleFor} from "../../src/components/arena/ArenaActivityFeed.js";
import type {TickerEvent} from "../../src/lib/arena/api.js";
import {C} from "../../src/lib/tokens.js";

function mkEvent(overrides: Partial<TickerEvent>): TickerEvent {
  return {
    id: 1,
    type: "RANK_CHANGED",
    priority: "MEDIUM",
    token: "$FILTER",
    address: "0x0000000000000000000000000000000000000001",
    message: "test",
    data: {},
    timestamp: "2026-05-05T12:00:00.000Z",
    ...overrides,
  };
}

describe("styleFor — RANK_CHANGED direction-aware mapping", () => {
  it("rank improvement (toRank < fromRank) → ↑ green", () => {
    const e = mkEvent({type: "RANK_CHANGED", data: {fromRank: 7, toRank: 3}});
    expect(styleFor(e)).toEqual({icon: "↑", color: C.green});
  });

  it("rank decline (toRank > fromRank) → ↓ yellow", () => {
    const e = mkEvent({type: "RANK_CHANGED", data: {fromRank: 4, toRank: 9}});
    expect(styleFor(e)).toEqual({icon: "↓", color: C.yellow});
  });

  it("rank tied (toRank == fromRank) → ↓ yellow (same direction as decline by convention)", () => {
    const e = mkEvent({type: "RANK_CHANGED", data: {fromRank: 5, toRank: 5}});
    expect(styleFor(e).color).toBe(C.yellow);
  });

  it("missing data falls back to the default RANK_CHANGED style", () => {
    const e = mkEvent({type: "RANK_CHANGED", data: {}});
    expect(styleFor(e).icon).toBe("↑"); // EVENT_TYPE_STYLES default
  });
});

describe("styleFor — HP_SPIKE direction-aware mapping", () => {
  it("positive delta → 📈 green", () => {
    const e = mkEvent({type: "HP_SPIKE", data: {hpDelta: 240}});
    expect(styleFor(e)).toEqual({icon: "📈", color: C.green});
  });

  it("negative delta → 📉 yellow", () => {
    const e = mkEvent({type: "HP_SPIKE", data: {hpDelta: -180}});
    expect(styleFor(e)).toEqual({icon: "📉", color: C.yellow});
  });

  it("zero delta → 📈 green (treated as non-negative)", () => {
    const e = mkEvent({type: "HP_SPIKE", data: {hpDelta: 0}});
    expect(styleFor(e).color).toBe(C.green);
  });

  it("missing hpDelta falls back to the default HP_SPIKE style", () => {
    const e = mkEvent({type: "HP_SPIKE", data: {}});
    expect(styleFor(e)).toEqual({icon: "📈", color: C.green});
  });
});

describe("ArenaActivityFeed — directional rendering", () => {
  it("RANK_UP and RANK_DOWN render with their direction-specific icons + colours", () => {
    const events = [
      mkEvent({type: "RANK_CHANGED", id: 1, data: {fromRank: 7, toRank: 3}, message: "$FOO ↑ rank 7 → 3"}),
      mkEvent({type: "RANK_CHANGED", id: 2, data: {fromRank: 4, toRank: 9}, message: "$BAR ↓ rank 4 → 9"}),
    ];
    const {container} = render(<ArenaActivityFeed events={events} />);
    const items = container.querySelectorAll("li[data-event-type='RANK_CHANGED']");
    expect(items.length).toBe(2);
    // First item: rank improvement → green
    const upMsg = items[0].querySelector("span:last-child") as HTMLElement | null;
    expect(upMsg?.style.color).toBe("rgb(82, 255, 139)"); // C.green
    expect(items[0].textContent).toContain("↑");
    // Second item: rank decline → yellow
    const downMsg = items[1].querySelector("span:last-child") as HTMLElement | null;
    expect(downMsg?.style.color).toBe("rgb(255, 233, 51)"); // C.yellow
    expect(items[1].textContent).toContain("↓");
  });

  it("falls back to ▼ cyan for an unknown future event type", () => {
    // Cast through unknown so the test can simulate wire-format drift —
    // production guarantees this never happens at runtime, but the
    // defensive fallback path is what we're pinning.
    const e = mkEvent({type: "FUTURE_TYPE_NOT_YET_HANDLED" as TickerEvent["type"], message: "future"});
    expect(styleFor(e)).toEqual({icon: "▼", color: C.cyan});
  });
});
