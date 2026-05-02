/// Component tests for the interactive ROI calculator (spec §45).
///
/// Asserts:
///   - risk disclosure copy is always present (cannot be hidden)
///   - presets snap state when clicked
///   - changing slider/outcome updates the output panel
///   - bounty + POL outputs only render in the wins scenario

import {fireEvent, render, screen, within} from "@testing-library/react";
import {parseEther} from "viem";
import {beforeEach, describe, expect, it} from "vitest";

import {RoiCalculator} from "@/components/launch/RoiCalculator";

const baseProps = {
  slotCostWei: parseEther("0.01"),
  stakeWei: parseEther("0.01"),
};

describe("RoiCalculator", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the non-removable risk disclosure", () => {
    render(<RoiCalculator {...baseProps} />);
    expect(screen.getByText(/most tokens get filtered/i)).toBeTruthy();
    // Link to the docs risk disclosure.
    const link = screen.getByRole("link", {name: /risk disclosure/i}) as HTMLAnchorElement;
    expect(link.href).toContain("docs.filter.fun/risks/risk-disclosure");
  });

  it("starts on the realistic preset (filtered, $50k MC, $100k volume)", () => {
    render(<RoiCalculator {...baseProps} />);
    // Preset button is aria-pressed when active.
    const realistic = screen.getByRole("button", {name: /realistic launch/i});
    expect(realistic.getAttribute("aria-pressed")).toBe("true");
    // Filtered radio is checked.
    const filtered = screen.getByRole("radio", {name: /filtered/i}) as HTMLInputElement;
    expect(filtered.checked).toBe(true);
  });

  it("snaps to the viral preset when clicked", () => {
    render(<RoiCalculator {...baseProps} />);
    const viral = screen.getByRole("button", {name: /viral winner/i});
    fireEvent.click(viral);
    expect(viral.getAttribute("aria-pressed")).toBe("true");
    const wins = screen.getByRole("radio", {name: /wins week/i}) as HTMLInputElement;
    expect(wins.checked).toBe(true);
  });

  it("hides bounty + POL outputs in non-wins scenarios", () => {
    render(<RoiCalculator {...baseProps} />);
    // Default is filtered — neither output should be visible.
    expect(screen.queryByText(/champion bounty/i)).toBeNull();
    expect(screen.queryByText(/POL backing/i)).toBeNull();
  });

  it("reveals bounty + POL outputs when outcome flips to wins", () => {
    render(<RoiCalculator {...baseProps} />);
    // Click the wins-week radio directly.
    fireEvent.click(screen.getByRole("radio", {name: /wins week/i}));
    expect(screen.getByText(/champion bounty/i)).toBeTruthy();
    expect(screen.getByText(/POL backing/i)).toBeTruthy();
  });

  it("renders breakeven volume derived from the slot cost", () => {
    render(<RoiCalculator {...baseProps} />);
    // 0.01 ETH × $3500 = $35; breakeven = $35 / 0.0020 = $17,500 → "$18k"
    // The fmtUsd compact form rounds to "$18k" at the $10k+ threshold.
    const breakevenRow = screen.getByText(/breakeven/i).parentElement!;
    const breakevenText = within(breakevenRow).getByText(/\$18k|\$17k/);
    expect(breakevenText).toBeTruthy();
  });

  it("renders dashes when slot cost hasn't loaded yet", () => {
    render(<RoiCalculator slotCostWei={0n} stakeWei={0n} />);
    // Two output rows fall back to "$—" — net out-of-pocket and breakeven.
    expect(screen.getAllByText("$—").length).toBeGreaterThanOrEqual(2);
  });

  it("uses real <input type='range'> sliders for keyboard accessibility", () => {
    render(<RoiCalculator {...baseProps} />);
    const sliders = document.querySelectorAll('input[type="range"]');
    expect(sliders.length).toBe(2);
  });
});
