/// ProfileBadges — verifies the defense-in-depth strip of ANNUAL_* badges
/// (spec §33.8, Epic 1.24). The indexer also strips them, but the web
/// layer is the belt half of belt-and-suspenders: even if the indexer were
/// to regress, the badges row never renders ANNUAL_FINALIST / ANNUAL_CHAMPION.

import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ProfileBadges} from "@/components/profile/ProfileBadges";

describe("ProfileBadges", () => {
  it("renders supported badges with their labels", () => {
    render(
      <ProfileBadges
        badges={["WEEK_WINNER", "FILTER_SURVIVOR", "QUARTERLY_FINALIST"]}
      />,
    );
    expect(screen.getByText("Week Winner")).toBeTruthy();
    expect(screen.getByText("Filter Survivor")).toBeTruthy();
    expect(screen.getByText("Quarterly Finalist")).toBeTruthy();
  });

  it("filters ANNUAL_* badges (spec §33.8 defense-in-depth)", () => {
    // Even if the indexer somehow ships ANNUAL_*, the web layer strips them.
    render(
      <ProfileBadges
        badges={["WEEK_WINNER", "ANNUAL_FINALIST", "ANNUAL_CHAMPION"]}
      />,
    );
    expect(screen.queryByText(/annual/i)).toBeNull();
    expect(screen.getByText("Week Winner")).toBeTruthy();
  });

  it("renders empty state when no badges qualify", () => {
    render(<ProfileBadges badges={[]} />);
    expect(screen.getByText(/No badges yet/)).toBeTruthy();
  });

  it("strips unknown badge strings (forward-compat)", () => {
    // A future indexer might ship a new badge type before the web is updated.
    // We don't render unknown names — they'd come through with no metadata.
    render(<ProfileBadges badges={["FUTURE_BADGE_TYPE"]} />);
    expect(screen.queryByText("FUTURE_BADGE_TYPE")).toBeNull();
    expect(screen.getByText(/No badges yet/)).toBeTruthy();
  });
});
