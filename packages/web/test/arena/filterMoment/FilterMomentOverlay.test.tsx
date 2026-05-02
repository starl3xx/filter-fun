/// Top-level overlay routing — verifies each stage renders the intended
/// surface and that idle/done suppress the overlay entirely.

import {render, screen, fireEvent} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

import {FilterMomentOverlay} from "@/components/arena/filterMoment/FilterMomentOverlay";

import {makeFixtureCohort, makeFixtureSeason} from "../fixtures";

const COHORT = makeFixtureCohort();

function baseProps(overrides: Partial<React.ComponentProps<typeof FilterMomentOverlay>> = {}) {
  return {
    stage: "idle" as const,
    cohortSnapshot: COHORT,
    filteredAddresses: new Set<`0x${string}`>(),
    walletFilteredTickers: [],
    walletEntitlementEth: null,
    championPoolDelta: "0",
    championPoolNow: "14.82",
    secondsUntilCut: 8 * 3600,
    season: makeFixtureSeason(),
    onDismiss: () => {},
    skipAnimation: true,
    ...overrides,
  };
}

describe("FilterMomentOverlay", () => {
  it("renders nothing in idle", () => {
    const {container} = render(<FilterMomentOverlay {...baseProps()} />);
    expect(container.querySelector(".ff-filter-moment-overlay")).toBeNull();
  });

  it("renders nothing in done (latched)", () => {
    const {container} = render(<FilterMomentOverlay {...baseProps({stage: "done"})} />);
    expect(container.querySelector(".ff-filter-moment-overlay")).toBeNull();
  });

  it("renders the countdown clock in countdown stage", () => {
    render(<FilterMomentOverlay {...baseProps({stage: "countdown", secondsUntilCut: 425})} />);
    expect(screen.getByRole("timer")).toBeTruthy();
    expect(screen.getByText("07:05")).toBeTruthy();
  });

  it("renders the broadcast strip in firing stage", () => {
    const filteredAddresses = new Set<`0x${string}`>([COHORT[6]!.token, COHORT[7]!.token, COHORT[8]!.token, COHORT[9]!.token, COHORT[10]!.token, COHORT[11]!.token]);
    render(
      <FilterMomentOverlay
        {...baseProps({stage: "firing", filteredAddresses})}
      />,
    );
    expect(screen.getByText(/FILTER LIVE/)).toBeTruthy();
    expect(screen.getByText(/6 SURVIVED/)).toBeTruthy();
  });

  it("renders the recap card in recap stage and dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn();
    const filteredAddresses = new Set<`0x${string}`>([COHORT[6]!.token, COHORT[7]!.token, COHORT[8]!.token, COHORT[9]!.token, COHORT[10]!.token, COHORT[11]!.token]);
    render(
      <FilterMomentOverlay
        {...baseProps({
          stage: "recap",
          filteredAddresses,
          onDismiss,
        })}
      />,
    );
    expect(screen.getByText(/FILTER COMPLETE/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {name: /view arena/i}));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("Esc dismisses the recap stage", () => {
    const onDismiss = vi.fn();
    render(
      <FilterMomentOverlay
        {...baseProps({
          stage: "recap",
          filteredAddresses: new Set<`0x${string}`>([COHORT[11]!.token]),
          onDismiss,
        })}
      />,
    );
    fireEvent.keyDown(window, {key: "Escape"});
    expect(onDismiss).toHaveBeenCalled();
  });
});
