/// HP breakdown popover — Epic 1.28 list-view enhancement.
///
/// Pins the hover-delay open behavior, instant close on leave, the canonical
/// 5-component spec §6.6 set being rendered, the holderConcentration read
/// from the live SSE frame, and reduced-motion preference handling.

import {act, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {HpBreakdownPopover} from "../../src/components/arena/HpBreakdownPopover.js";
import type {HpUpdate} from "../../src/hooks/arena/useHpUpdates.js";
import type {TokenResponse} from "../../src/lib/arena/api.js";

function tokenFixture(): TokenResponse {
  return {
    token: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    ticker: "$FILTER",
    rank: 1,
    hp: 9540,
    status: "FINALIST",
    price: "0.0001",
    priceChange24h: 0,
    volume24h: "0",
    liquidity: "1000",
    holders: 8400,
    components: {
      velocity: 0.91,
      effectiveBuyers: 0.97,
      stickyLiquidity: 0.84,
      retention: 0.62,
      momentum: 0.5,
    },
    bagLock: {isLocked: false, unlockTimestamp: null, creator: "0x0"} as TokenResponse["bagLock"],
  };
}

function liveHpFixture(): HpUpdate {
  return {
    hp: 9540,
    components: {
      velocity: 0.91,
      effectiveBuyers: 0.97,
      stickyLiquidity: 0.84,
      retention: 0.62,
      momentum: 0.5,
      holderConcentration: 0.88,
    },
    weightsVersion: "v1",
    computedAt: 1234,
    trigger: "BLOCK_TICK",
    receivedAtIso: "2026-05-05T12:00:00.000Z",
  };
}

describe("HpBreakdownPopover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("hidden initially when active=false", () => {
    render(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={false} />);
    const pop = screen.getByTestId("hp-breakdown-popover");
    expect(pop.getAttribute("data-hp-popover-shown")).toBe("false");
  });

  it("opens after the 200ms hover delay (no reduced-motion)", () => {
    const {rerender} = render(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={false} />);
    rerender(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={true} />);
    expect(screen.getByTestId("hp-breakdown-popover").getAttribute("data-hp-popover-shown")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.getByTestId("hp-breakdown-popover").getAttribute("data-hp-popover-shown")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.getByTestId("hp-breakdown-popover").getAttribute("data-hp-popover-shown")).toBe("true");
  });

  it("closes immediately when active flips back to false (no exit delay)", () => {
    const {rerender} = render(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={true} />);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByTestId("hp-breakdown-popover").getAttribute("data-hp-popover-shown")).toBe("true");
    rerender(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={false} />);
    expect(screen.getByTestId("hp-breakdown-popover").getAttribute("data-hp-popover-shown")).toBe("false");
  });

  it("renders the canonical 5-component spec §6.6 set with their labels", () => {
    render(<HpBreakdownPopover token={tokenFixture()} liveHp={liveHpFixture()} active={true} />);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const text = screen.getByTestId("hp-breakdown-popover").textContent ?? "";
    expect(text).toContain("Buying activity");
    expect(text).toContain("Buyer breadth");
    expect(text).toContain("Liquidity strength");
    expect(text).toContain("Holder conviction");
    expect(text).toContain("Distribution health");
    // Renders the HP total in the header (9,540 / 10,000).
    expect(text).toContain("9,540");
    expect(text).toContain("10,000");
  });

  it("reads holderConcentration off liveHp; falls back to 0 when absent", () => {
    render(<HpBreakdownPopover token={tokenFixture()} liveHp={liveHpFixture()} active={true} />);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    // 0.88 → 88
    expect(screen.getByTestId("hp-breakdown-popover").textContent).toContain("88");

    // Without liveHp, holderConcentration falls back to 0.
    const {container} = render(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={true} />);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    // The Distribution health row in the second instance should show 0.
    const distRow = Array.from(container.querySelectorAll("div")).find(
      (d) => d.textContent?.includes("Distribution health"),
    );
    expect(distRow?.textContent).toContain("0");
  });
});

describe("HpBreakdownPopover reduced-motion", () => {
  beforeEach(() => {
    // Stub matchMedia so prefers-reduced-motion: reduce returns true.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("opens instantly (no 200ms delay) when prefers-reduced-motion is reduce", () => {
    const {rerender} = render(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={false} />);
    rerender(<HpBreakdownPopover token={tokenFixture()} liveHp={null} active={true} />);
    // No timer advance — should be visible immediately.
    expect(screen.getByTestId("hp-breakdown-popover").getAttribute("data-hp-popover-shown")).toBe("true");
  });
});
