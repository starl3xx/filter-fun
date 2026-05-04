/// Component tests for the enhanced /launch CostPanel (spec §45.2).
///
/// Asserts:
///   - launch cost + USD column rendered
///   - refundable stake row shows when stake mode is on
///   - total committed = launch + stake
///   - "while live, you earn" + "if you win" sections present
///   - bounty/POL projections derive from the live championPool when supplied

import {render, screen} from "@testing-library/react";
import {parseEther} from "viem";
import {describe, expect, it} from "vitest";

import {CostPanel} from "@/components/launch/CostPanel";

describe("CostPanel — full economic picture", () => {
  it("renders launch cost with ETH + USD at the fallback rate", () => {
    render(<CostPanel slotIndex={0} launchCostWei={parseEther("0.01")} stakeWei={0n} />);
    // ETH formatter from lib/launch/format uses 3 decimals. With stake=0,
    // launch cost === total, so "Ξ0.010" / "$35" both render twice.
    expect(screen.getAllByText("Ξ0.010").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$35").length).toBeGreaterThanOrEqual(1);
  });

  it("hides the stake row when stake mode is off", () => {
    render(<CostPanel slotIndex={0} launchCostWei={parseEther("0.01")} stakeWei={0n} />);
    expect(screen.queryByText(/refundable stake/i)).toBeNull();
  });

  it("renders stake + total committed when stake mode is on", () => {
    render(
      <CostPanel slotIndex={0} launchCostWei={parseEther("0.01")} stakeWei={parseEther("0.01")} />,
    );
    expect(screen.getByText(/refundable stake/i)).toBeTruthy();
    expect(screen.getByText(/total committed/i)).toBeTruthy();
    // Total = 0.02 ETH = $70
    expect(screen.getByText("Ξ0.020")).toBeTruthy();
    expect(screen.getByText("$70")).toBeTruthy();
  });

  it("renders the 'while live' earnings line", () => {
    render(<CostPanel slotIndex={0} launchCostWei={parseEther("0.01")} stakeWei={0n} />);
    expect(screen.getByText(/while live, you earn/i)).toBeTruthy();
    expect(screen.getByText(/0\.20% of all trading volume/i)).toBeTruthy();
  });

  it("renders the 'if you win' bounty + Reserve lines", () => {
    render(<CostPanel slotIndex={0} launchCostWei={parseEther("0.01")} stakeWei={0n} />);
    expect(screen.getByText(/if your token wins/i)).toBeTruthy();
    expect(screen.getByText(/2\.5% champion bounty/i)).toBeTruthy();
    expect(screen.getByText(/filter fund liquidity reserve/i)).toBeTruthy();
  });

  it("renders a bounty range from the live championPool when supplied", () => {
    render(
      <CostPanel
        slotIndex={0}
        launchCostWei={parseEther("0.01")}
        stakeWei={0n}
        championPoolEth={20}
      />,
    );
    // Pool 20 ETH → bounty 0.5; mid scaling to 60 ETH at end of week → 1.5
    // Display uses 4 decimals via fmtEth4: "Ξ0.5000 – Ξ1.5000"
    const bountyLine = screen.getByText(/2\.5% champion bounty/i);
    expect(bountyLine.textContent).toContain("Ξ0.5000");
    expect(bountyLine.textContent).toContain("Ξ1.5000");
  });

  it("uses a sensible heuristic when no championPool is supplied", () => {
    render(<CostPanel slotIndex={0} launchCostWei={parseEther("0.01")} stakeWei={0n} />);
    // Default range 4–40 ETH → bounty 0.1–1
    const bountyLine = screen.getByText(/2\.5% champion bounty/i);
    expect(bountyLine.textContent).toContain("Ξ0.1000");
    expect(bountyLine.textContent).toContain("Ξ1.0000");
  });
});
