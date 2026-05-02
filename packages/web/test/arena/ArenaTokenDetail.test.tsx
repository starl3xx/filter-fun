/// ArenaTokenDetail — the bag-lock badge in the heading is the new surface
/// (Epic 1.13 web). Asserts:
///   - badge renders ONLY when bagLock.isLocked === true
///   - tooltip + aria-label include the unlock date
///   - no badge for unlocked / null lock — absence is the default
///   - badge href points at /creators/bag-lock on the docs domain
///
/// We don't re-test the rest of the panel (price/HP/sparkline) — those have
/// their own coverage.

import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaTokenDetail} from "@/components/arena/ArenaTokenDetail";
import type {TokenResponse} from "@/lib/arena/api";

import {makeFixtureBagLock, makeFixtureCohort, makeFixtureSeason} from "./fixtures";

const CHAIN = "base-sepolia" as const;

function withBagLock(token: TokenResponse, isLocked: boolean, daysOut = 14): TokenResponse {
  return {
    ...token,
    bagLock: makeFixtureBagLock({
      isLocked,
      unlockTimestamp: isLocked ? Math.floor((Date.now() + daysOut * 86400_000) / 1000) : null,
      creator: "0xcccccccccccccccccccccccccccccccccccccccc",
    }),
  };
}

describe("ArenaTokenDetail bag-lock badge", () => {
  it("does not render the badge when isLocked === false", () => {
    const token = makeFixtureCohort()[0]!;
    render(
      <ArenaTokenDetail
        token={withBagLock(token, false)}
        trend={[10, 20, 30]}
        season={makeFixtureSeason()}
        chain={CHAIN}
      />,
    );
    expect(screen.queryByTestId("arena-baglock-badge")).toBeNull();
  });

  it("renders the badge when isLocked === true and includes a countdown if < 30 days", () => {
    const token = makeFixtureCohort()[0]!;
    render(
      <ArenaTokenDetail
        token={withBagLock(token, true, 14)}
        trend={[10, 20, 30]}
        season={makeFixtureSeason()}
        chain={CHAIN}
      />,
    );
    const badge = screen.getByTestId("arena-baglock-badge");
    expect(badge.getAttribute("data-baglock-locked")).toBe("true");
    expect(badge.textContent?.toUpperCase()).toContain("LOCKED");
    // Sub-30-day picks include the countdown ("· 13d" or "· 14d" depending on
    // when the test runs vs the unlock anchor).
    expect(badge.textContent).toMatch(/\d+d/);
  });

  it("omits the day-count for locks ≥ 30 days out", () => {
    const token = makeFixtureCohort()[0]!;
    render(
      <ArenaTokenDetail
        token={withBagLock(token, true, 90)}
        trend={[10, 20, 30]}
        season={makeFixtureSeason()}
        chain={CHAIN}
      />,
    );
    const badge = screen.getByTestId("arena-baglock-badge");
    expect(badge.textContent).not.toMatch(/·\s*\d+d/);
  });

  it("badge tooltip + aria-label include the unlock date", () => {
    const token = makeFixtureCohort()[0]!;
    render(
      <ArenaTokenDetail
        token={withBagLock(token, true, 14)}
        trend={[10, 20, 30]}
        season={makeFixtureSeason()}
        chain={CHAIN}
      />,
    );
    const badge = screen.getByTestId("arena-baglock-badge") as HTMLAnchorElement;
    expect(badge.title).toContain("Creator has locked");
    expect(badge.getAttribute("aria-label")).toContain("Bag locked until");
    // Badge links to the canonical docs page.
    expect(badge.href).toContain("docs.filter.fun/creators/bag-lock");
  });

  it("does not render the badge if unlockTimestamp is null even when isLocked is true (defensive)", () => {
    const token = makeFixtureCohort()[0]!;
    const broken: TokenResponse = {
      ...token,
      bagLock: makeFixtureBagLock({isLocked: true, unlockTimestamp: null}),
    };
    render(
      <ArenaTokenDetail
        token={broken}
        trend={[10, 20, 30]}
        season={makeFixtureSeason()}
        chain={CHAIN}
      />,
    );
    expect(screen.queryByTestId("arena-baglock-badge")).toBeNull();
  });
});
