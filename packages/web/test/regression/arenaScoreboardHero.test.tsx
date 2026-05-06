/// Arena scoreboard hero — Epic 1.28.
///
/// Pins the four-state branching machine (reservation / aborted / sub-12 /
/// steady-state) and the cohort-edge math (spec §6.10). The visual treatment
/// itself is exercised by the snapshot suite; here we lock the state-derivation
/// logic so a future indexer payload change can't silently regress the framing.

import {render} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {ArenaScoreboardHero, cohortEdgeSplit, deriveHeroState} from "../../src/components/arena/ArenaScoreboardHero.js";
import type {SeasonResponse, TokenResponse} from "../../src/lib/arena/api.js";

function seasonFixture(overrides?: Partial<SeasonResponse>): SeasonResponse {
  return {
    seasonId: 2,
    phase: "competition",
    launchCount: 12,
    maxLaunches: 12,
    nextCutAt: new Date(Date.now() + 4 * 60 * 60 * 1000 + 10 * 60 * 1000 + 58 * 1000).toISOString(),
    finalSettlementAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    championPool: "14.82",
    polReserve: "6.42",
    ...overrides,
  };
}

function tokenAt(rank: number): TokenResponse {
  return {
    token: `0x${rank.toString().padStart(40, "0")}` as `0x${string}`,
    ticker: `$T${rank}`,
    rank,
    hp: 5000,
    status: "SAFE",
    price: "0.0001",
    priceChange24h: 0,
    volume24h: "0",
    liquidity: "1000",
    holders: 100,
    components: {velocity: 0.5, effectiveBuyers: 0.5, stickyLiquidity: 0.5, retention: 0.5, momentum: 0.5},
    bagLock: {isLocked: false, unlockTimestamp: null, creator: "0x0"} as TokenResponse["bagLock"],
  };
}

const COHORT_FULL: TokenResponse[] = Array.from({length: 12}, (_, i) => tokenAt(i + 1));

describe("deriveHeroState — pre-launch state machine (spec §46 + §6.10)", () => {
  it("aborted overrides everything", () => {
    expect(deriveHeroState({season: seasonFixture(), cohort: COHORT_FULL, aborted: true})).toBe("aborted");
  });

  it("missing season → reservation (initial render before /season responds)", () => {
    expect(deriveHeroState({season: null, cohort: []})).toBe("reservation");
  });

  it("phase=launch with sub-12 reservations → reservation", () => {
    const season = seasonFixture({phase: "launch", launchCount: 7});
    expect(deriveHeroState({season, cohort: [], reservationCount: 7})).toBe("reservation");
  });

  it("phase=launch with 12/12 reservations → active (about to flip phases)", () => {
    const season = seasonFixture({phase: "launch", launchCount: 12});
    expect(deriveHeroState({season, cohort: COHORT_FULL, reservationCount: 12})).toBe("active");
  });

  it("phase=competition → active regardless of cohort size (sub-12 still reads as active)", () => {
    expect(deriveHeroState({season: seasonFixture(), cohort: COHORT_FULL.slice(0, 9)})).toBe("active");
  });

  it("phase=settled → active (post-finalize keeps the figures visible)", () => {
    expect(deriveHeroState({season: seasonFixture({phase: "settled"}), cohort: COHORT_FULL})).toBe("active");
  });
});

describe("cohortEdgeSplit — spec §6.10 cohort-edge math", () => {
  it("steady-state full cohort: 12 → 6 / 6", () => {
    expect(cohortEdgeSplit(12)).toEqual({survivors: 6, cut: 6});
  });

  it("sub-12 odd cohort: 11 → 5 / 6 (cut bears the burden of the odd row)", () => {
    expect(cohortEdgeSplit(11)).toEqual({survivors: 5, cut: 6});
  });

  it("sub-12 even cohort: 8 → 4 / 4", () => {
    expect(cohortEdgeSplit(8)).toEqual({survivors: 4, cut: 4});
  });

  it("9 → 4 / 5", () => {
    expect(cohortEdgeSplit(9)).toEqual({survivors: 4, cut: 5});
  });

  it("7 → 3 / 4", () => {
    expect(cohortEdgeSplit(7)).toEqual({survivors: 3, cut: 4});
  });

  it("zero cohort handles gracefully", () => {
    expect(cohortEdgeSplit(0)).toEqual({survivors: 0, cut: 0});
  });
});

describe("ArenaScoreboardHero rendering (state surface)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("steady-state full cohort renders 12 / 6 / 6 mini-stats and live ETH figures", () => {
    const {getByTestId} = render(
      <ArenaScoreboardHero season={seasonFixture()} cohort={COHORT_FULL} />,
    );
    const hero = getByTestId("scoreboard-hero");
    expect(hero.getAttribute("data-hero-state")).toBe("active");
    const fund = getByTestId("hero-card-fund");
    expect(fund.textContent).toContain("Ξ14.82");
    const reserve = getByTestId("hero-card-reserve");
    expect(reserve.textContent).toContain("Ξ6.42");
    const countdown = getByTestId("hero-card-countdown");
    expect(countdown.textContent).toContain("In arena");
    expect(countdown.textContent).toContain("12");
    expect(countdown.textContent).toContain("Survivors");
    expect(countdown.textContent).toContain("Cut");
  });

  it("sub-12 active cohort applies §6.10 cohort-edge split (11 → 5 / 6)", () => {
    const {getByTestId} = render(
      <ArenaScoreboardHero season={seasonFixture()} cohort={COHORT_FULL.slice(0, 11)} />,
    );
    const countdown = getByTestId("hero-card-countdown");
    // Survivor / Cut counts surface in the mini-stat grid; we read the
    // adjacency via textContent — the values aren't unique strings on their
    // own, so we check the grouped substring.
    expect(countdown.textContent).toContain("11");
    expect(countdown.textContent).toContain("5");
    expect(countdown.textContent).toContain("6");
  });

  it("helper text interpolates the live cut count (bugbot pass-1)", () => {
    // Steady-state cohort (12 → 6 cut): "Bottom 6 get cut".
    const {getByTestId, rerender} = render(
      <ArenaScoreboardHero season={seasonFixture()} cohort={COHORT_FULL} />,
    );
    expect(getByTestId("hero-card-countdown").textContent).toContain("Bottom 6 get cut");
    // Sub-12 cohort (8 → 4 cut): "Bottom 4 get cut" — pre-fix this stayed
    // hardcoded at "Bottom 6 get cut" and contradicted the mini-stats grid.
    rerender(<ArenaScoreboardHero season={seasonFixture()} cohort={COHORT_FULL.slice(0, 8)} />);
    expect(getByTestId("hero-card-countdown").textContent).toContain("Bottom 4 get cut");
    expect(getByTestId("hero-card-countdown").textContent).not.toContain("Bottom 6");
  });

  it("reservation phase shows '0/12 reservations · activates at 4'", () => {
    const season = seasonFixture({phase: "launch", launchCount: 0});
    const {getByTestId} = render(
      <ArenaScoreboardHero season={season} cohort={[]} reservationCount={0} />,
    );
    const hero = getByTestId("scoreboard-hero");
    expect(hero.getAttribute("data-hero-state")).toBe("reservation");
    const countdown = getByTestId("hero-card-countdown");
    expect(countdown.textContent).toContain("0/12");
    expect(countdown.textContent).toContain("activates at 4");
  });

  it("aborted state mutes the hero (opacity 0.5) and reads 'Aborted'", () => {
    const {getByTestId} = render(
      <ArenaScoreboardHero season={seasonFixture()} cohort={[]} aborted />,
    );
    const hero = getByTestId("scoreboard-hero");
    expect(hero.getAttribute("data-hero-state")).toBe("aborted");
    expect((hero as HTMLElement).style.opacity).toBe("0.5");
    expect(getByTestId("hero-card-countdown").textContent).toContain("ABORTED");
  });

  it("Filter Fund card carries the 4-destination split copy in active state", () => {
    const {getByTestId} = render(
      <ArenaScoreboardHero season={seasonFixture()} cohort={COHORT_FULL} />,
    );
    const fund = getByTestId("hero-card-fund");
    expect(fund.textContent).toContain("2.5% creator bounty");
    expect(fund.textContent).toContain("both groups of holders");
    expect(fund.textContent).toContain("hold bonus");
    expect(fund.textContent).toContain("permanent LP");
  });

  it("Liquidity Reserve card carries 'Cannot be withdrawn' permanence framing", () => {
    const {getByTestId} = render(
      <ArenaScoreboardHero season={seasonFixture()} cohort={COHORT_FULL} />,
    );
    expect(getByTestId("hero-card-reserve").textContent).toContain("Cannot be withdrawn");
    expect(getByTestId("hero-card-reserve").textContent).toContain("Backstops the champion forever");
  });
});
