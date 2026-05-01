/// Component tests for the launch slot grid.
///
/// Asserts the contract pieces the spec calls out explicitly:
///   - 12 cards always render
///   - First empty card is the "Claim now" card
///   - Slots 9-11 carry "Almost gone" treatment when empty
///   - Closed-window slots dim to "Closed"

import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {SlotGrid} from "@/components/launch/SlotGrid";

import {makeFixtureSlots} from "./fixtures";

describe("SlotGrid", () => {
  it("renders 12 slot cards regardless of fill count", () => {
    const slots = makeFixtureSlots(3);
    const {container} = render(<SlotGrid slots={slots} />);
    // Each slot card carries a "SLOT NN" label — query by that.
    const labels = container.querySelectorAll("[class*='ff-launch-slot-grid'] > *");
    expect(labels).toHaveLength(12);
  });

  it("highlights the first empty slot as Claim now", () => {
    const slots = makeFixtureSlots(8);
    render(<SlotGrid slots={slots} />);
    expect(screen.getAllByText(/claim now/i)).toHaveLength(1);
  });

  it("flags slots ≥ #10 as 'Almost gone' when empty", () => {
    const slots = makeFixtureSlots(8);
    render(<SlotGrid slots={slots} />);
    // Slots 10, 11, 12 (indexes 9, 10, 11) — three "Almost gone" cards.
    expect(screen.getAllByText(/almost gone/i)).toHaveLength(3);
  });

  it("renders Closed for empty slots when window is closed", () => {
    const slots = makeFixtureSlots(5, {windowOpen: false});
    render(<SlotGrid slots={slots} />);
    expect(screen.getAllByText(/^closed$/i).length).toBeGreaterThanOrEqual(7);
  });

  it("renders ticker + HP for filled slots", () => {
    const slots = makeFixtureSlots(2);
    render(<SlotGrid slots={slots} />);
    expect(screen.getByText("$FILTER")).toBeTruthy();
    expect(screen.getByText("$BLOOD")).toBeTruthy();
  });
});
