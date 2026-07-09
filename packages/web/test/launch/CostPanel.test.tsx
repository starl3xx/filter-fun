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

/// Epic 2.6 (spec §47.3.8) — Filter Club credit rendering. Per the M-Ux-4
/// rationale in CostPanel.tsx, a zero total is visually indistinguishable
/// from a free launch, so a DELIBERATE free launch must be loudly labeled:
/// badge + struck-through slot cost + explicit Ξ0 total with the credit note.
describe("CostPanel — creditApplied (Filter Club)", () => {
  it("renders the FREE badge and the credit note", () => {
    render(
      <CostPanel
        slotIndex={0}
        launchCostWei={parseEther("0.01")}
        stakeWei={0n}
        creditApplied
      />,
    );
    expect(screen.getByTestId("cost-panel-credit-badge").textContent).toMatch(
      /FREE — Filter Club credit/,
    );
    expect(screen.getByTestId("cost-panel-credit-note").textContent).toMatch(
      /credit covers this slot/i,
    );
  });

  it("strikes through the slot cost but keeps the original value visible", () => {
    render(
      <CostPanel
        slotIndex={0}
        launchCostWei={parseEther("0.01")}
        stakeWei={0n}
        creditApplied
      />,
    );
    // The would-have-paid cost stays rendered (struck), so the user sees
    // what the credit is worth.
    const costCell = screen.getByText("Ξ0.010");
    const struckWrap = costCell.closest("span[style]") as HTMLElement | null;
    expect(struckWrap?.parentElement?.getAttribute("style") ?? "").toContain("line-through");
  });

  it("renders the total as an explicit Ξ0 (not the struck cost)", () => {
    render(
      <CostPanel
        slotIndex={0}
        launchCostWei={parseEther("0.01")}
        stakeWei={parseEther("0.01")}
        creditApplied
      />,
    );
    // Total committed = 0 — a credit launch sends value: 0n; the contract
    // retains no cost and no stake. (fmtUsd's sub-$1 branch renders "$0.00".)
    expect(screen.getByText("Ξ0.000")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
    // The stake-refund copy would be a lie on a zero-value tx — suppressed.
    expect(screen.queryByText(/stake refunds to your wallet/i)).toBeNull();
  });

  it("keeps the loading-dash discipline when costLoading wins", () => {
    render(
      <CostPanel
        slotIndex={0}
        launchCostWei={0n}
        stakeWei={0n}
        creditApplied
        costLoading
      />,
    );
    // While the status read is in flight the cells stay dashes — a
    // struck-through zero would be the exact M-Ux-4 lie in new clothes.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("Ξ0.000")).toBeNull();
    // The badge still renders — it signals the user's toggle intent, not
    // contract data.
    expect(screen.getByTestId("cost-panel-credit-badge")).toBeTruthy();
  });
});
