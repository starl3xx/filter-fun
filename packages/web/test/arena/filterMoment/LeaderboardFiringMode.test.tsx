/// Leaderboard interactions with the filter-moment overlay (Epic 1.9).
/// Specifically tests the urgent-cutline / firing-mode prop combinations
/// that the overlay drives during stages countdown / firing / recap.

import {render, screen, within} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaLeaderboard} from "@/components/arena/ArenaLeaderboard";

import {makeFixtureCohort} from "../fixtures";

describe("ArenaLeaderboard — filter-moment props", () => {
  it("renders AT RISK chips on rows 5-8 in urgent-cutline mode", () => {
    const cohort = makeFixtureCohort();
    render(
      <ArenaLeaderboard
        tokens={cohort}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
        urgentCutline
      />,
    );
    const chips = document.querySelectorAll('[data-chip="at-risk"]');
    // Rows 5, 6, 7, 8 (zero-indexed 4..7) — four chips total.
    expect(chips.length).toBe(4);
  });

  it("does not render AT RISK chips when urgent-cutline is off", () => {
    render(
      <ArenaLeaderboard
        tokens={makeFixtureCohort()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelectorAll('[data-chip="at-risk"]').length).toBe(0);
  });

  it("applies the urgent-cutline class to the cut line in urgent mode", () => {
    render(
      <ArenaLeaderboard
        tokens={makeFixtureCohort()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
        urgentCutline
      />,
    );
    const cutline = screen.getByRole("separator", {name: /cut line/i});
    expect(cutline.className).toContain("ff-arena-cutline--urgent");
  });

  it("stamps filtered rows in firing mode", () => {
    const cohort = makeFixtureCohort();
    const filtered = new Set<`0x${string}`>([cohort[6]!.token, cohort[11]!.token]);
    const {container} = render(
      <ArenaLeaderboard
        tokens={cohort}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
        firingMode
        recentlyFilteredAddresses={filtered}
      />,
    );
    const stamps = container.querySelectorAll(".ff-arena-row-filter-stamp");
    expect(stamps.length).toBe(2);
  });

  it("survivor rows above the cut get the survivor class in firing mode", () => {
    const cohort = makeFixtureCohort();
    // Bottom six are filtered; top six should pick up the survivor halo.
    const filtered = new Set<`0x${string}`>(cohort.slice(6).map((t) => t.token));
    const {container} = render(
      <ArenaLeaderboard
        tokens={cohort}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
        firingMode
        recentlyFilteredAddresses={filtered}
      />,
    );
    expect(container.querySelectorAll(".ff-arena-row-survivor").length).toBe(6);
    expect(container.querySelectorAll(".ff-arena-row-filtered").length).toBe(6);
  });

  it("urgent + firing modes can coexist (recap stage carries both visually)", () => {
    const cohort = makeFixtureCohort();
    const filtered = new Set<`0x${string}`>([cohort[11]!.token]);
    render(
      <ArenaLeaderboard
        tokens={cohort}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
        urgentCutline
        firingMode
        recentlyFilteredAddresses={filtered}
      />,
    );
    // Filtered rows must NOT also carry the AT RISK chip — the row was
    // already filtered, so the warning chip is moot.
    const filteredButton = screen.getAllByRole("button").at(11)!;
    const chip = within(filteredButton).queryAllByText(/AT RISK/i);
    expect(chip.length).toBe(0);
  });
});
