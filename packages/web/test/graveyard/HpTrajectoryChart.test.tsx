/// HpTrajectoryChart — empty state + cut-line marker rendering.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {HpTrajectoryChart} from "@/components/graveyard/HpTrajectoryChart";

describe("HpTrajectoryChart", () => {
  it("renders the empty-state copy when given zero points", () => {
    const {container} = render(<HpTrajectoryChart points={[]} />);
    expect(container.textContent).toContain("No HP samples");
  });

  it("renders an SVG line for non-empty series", () => {
    const points = [
      {timestamp: 1000, hp: 0},
      {timestamp: 1100, hp: 4500},
      {timestamp: 1200, hp: 2000},
    ];
    const {container} = render(<HpTrajectoryChart points={points} />);
    const path = container.querySelector("path");
    expect(path).not.toBeNull();
  });

  it("renders cut-line marker when cutLineHp is set", () => {
    const points = [
      {timestamp: 1000, hp: 0},
      {timestamp: 1100, hp: 4500},
    ];
    const {container} = render(
      <HpTrajectoryChart points={points} cutLineHp={5000} />,
    );
    expect(container.textContent).toContain("cut line 5000");
  });

  it("does NOT render cut-line marker when cutLineHp is null", () => {
    const points = [
      {timestamp: 1000, hp: 0},
      {timestamp: 1100, hp: 4500},
    ];
    const {container} = render(
      <HpTrajectoryChart points={points} cutLineHp={null} />,
    );
    expect(container.textContent).not.toContain("cut line");
  });

  it("renders peak marker when peakHp + peakAtSec are provided", () => {
    const points = [
      {timestamp: 1000, hp: 0},
      {timestamp: 1100, hp: 6000},
    ];
    const {container} = render(
      <HpTrajectoryChart points={points} peakHp={6000} peakAtSec={1100} />,
    );
    expect(container.textContent).toContain("peak 6000");
  });
});
