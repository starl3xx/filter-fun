/// CountdownClock — purely presentational, but the MM:SS formatting and
/// final-10-seconds urgency switch are both behaviorally observable.

import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {CountdownClock} from "@/components/arena/filterMoment/CountdownClock";

describe("CountdownClock", () => {
  it("renders MM:SS for normal countdown values", () => {
    render(<CountdownClock secondsUntil={245} />);
    expect(screen.getByText("04:05")).toBeTruthy();
  });

  it("clamps negative values to 00:00", () => {
    render(<CountdownClock secondsUntil={-5} />);
    expect(screen.getByText("00:00")).toBeTruthy();
  });

  it("applies the urgent class for the final ten seconds", () => {
    const {container} = render(<CountdownClock secondsUntil={4} />);
    expect(container.querySelector(".ff-filter-moment-clock-urgent")).toBeTruthy();
    expect(container.querySelector(".ff-filter-moment-clock-pulse")).toBeNull();
  });

  it("uses the calm pulse class outside the final ten seconds", () => {
    const {container} = render(<CountdownClock secondsUntil={120} />);
    expect(container.querySelector(".ff-filter-moment-clock-pulse")).toBeTruthy();
    expect(container.querySelector(".ff-filter-moment-clock-urgent")).toBeNull();
  });

  it("compact variant drops the spec copy and renders inline", () => {
    render(<CountdownClock secondsUntil={59} variant="compact" />);
    expect(screen.queryByText(/Top 6 survive/i)).toBeNull();
    expect(screen.getByText("00:59")).toBeTruthy();
  });
});
