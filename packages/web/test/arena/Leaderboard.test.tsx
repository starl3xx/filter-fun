/// Component tests for the arena leaderboard.
///
/// Asserts the contract pieces the spec calls out explicitly:
///   - 12 rows render in correct rank order
///   - Cut line renders between rank 6 and rank 7 in `competition` phase
///   - Status badges map correctly to rank/state

import {render, screen, within} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

import {ArenaLeaderboard} from "@/components/arena/ArenaLeaderboard";

import {makeFixtureCohort} from "./fixtures";

describe("ArenaLeaderboard", () => {
  it("renders 12 rows in ascending rank order", () => {
    const cohort = makeFixtureCohort();
    render(
      <ArenaLeaderboard
        tokens={cohort}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(12);
    // Each row's accessible name embeds rank + ticker — easier to assert against
    // than DOM order by class.
    for (let i = 0; i < cohort.length; i++) {
      expect(buttons[i]?.getAttribute("aria-label")).toContain(`rank ${i + 1}`);
      expect(buttons[i]?.getAttribute("aria-label")).toContain(cohort[i]!.ticker);
    }
  });

  it("renders the cut line between rank 6 and rank 7", () => {
    render(
      <ArenaLeaderboard
        tokens={makeFixtureCohort()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
      />,
    );
    const cutline = screen.getByRole("separator", {name: /cut line/i});
    // Walk the previous siblings (which include other separators / column header) and
    // count the rows before the cut line. The leaderboard renders 6 row buttons before it.
    const parent = cutline.parentElement!;
    const rowsBefore = within(parent).getAllByRole("button");
    expect(rowsBefore.length).toBeGreaterThanOrEqual(12);
    const cutIndex = Array.from(parent.children).indexOf(cutline);
    const buttonsBeforeCut = Array.from(parent.children)
      .slice(0, cutIndex)
      .filter((el) => el.tagName === "BUTTON");
    expect(buttonsBeforeCut).toHaveLength(6);
  });

  it("hides the cut line when hideCutLine is set (launch phase)", () => {
    render(
      <ArenaLeaderboard
        tokens={makeFixtureCohort()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
        hideCutLine
      />,
    );
    expect(screen.queryByRole("separator", {name: /cut line/i})).toBeNull();
  });

  it("maps status badges correctly across the cohort", () => {
    render(
      <ArenaLeaderboard
        tokens={makeFixtureCohort()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
      />,
    );
    // Pull each row's badge by rank.
    const rows = screen.getAllByRole("button");
    const expected = [
      // rank 1, 2 → FINALIST (top of finalist range in our fixture)
      "FINALIST", "FINALIST",
      // rank 3-6 → SAFE
      "SAFE", "SAFE", "SAFE", "SAFE",
      // rank 7-9 → AT_RISK
      "AT_RISK", "AT_RISK", "AT_RISK",
      // rank 10-12 → FILTERED
      "FILTERED", "FILTERED", "FILTERED",
    ];
    for (let i = 0; i < expected.length; i++) {
      const badge = rows[i]?.querySelector("[data-status]");
      expect(badge?.getAttribute("data-status")).toBe(expected[i]);
    }
  });

  it("calls onSelect with the row's address when clicked", () => {
    const onSelect = vi.fn();
    const cohort = makeFixtureCohort();
    render(
      <ArenaLeaderboard
        tokens={cohort}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={onSelect}
      />,
    );
    const rows = screen.getAllByRole("button");
    rows[2]?.click();
    expect(onSelect).toHaveBeenCalledWith(cohort[2]!.token);
  });

  it("re-sorts rows defensively if the input is out-of-order", () => {
    const cohort = makeFixtureCohort();
    // Reverse the array — the leaderboard should still render rank-1 first.
    render(
      <ArenaLeaderboard
        tokens={[...cohort].reverse()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]?.getAttribute("aria-label")).toContain("rank 1");
    expect(buttons[11]?.getAttribute("aria-label")).toContain("rank 12");
  });
});
