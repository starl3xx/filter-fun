/// State-derivation tests for the arena ticker. The visual output is
/// driven by `deriveState(events, season, now)`; locking that function down
/// keeps the 5-state UI predictable.

import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaTicker, deriveState} from "@/components/arena/ArenaTicker";
import type {TickerEvent} from "@/lib/arena/api";

import {makeFixtureEvent, makeFixtureSeason} from "./fixtures";

const NOW = new Date("2026-04-30T12:00:00Z");

function isoDelta(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

describe("deriveState", () => {
  it("returns normal for an idle stream and a non-imminent cut", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(8 * 3600_000)});
    expect(deriveState([], season, NOW)).toBe("normal");
  });

  it("returns filter-moment for ≤10s after a FILTER_FIRED", () => {
    const events: TickerEvent[] = [
      makeFixtureEvent({type: "FILTER_FIRED", timestamp: isoDelta(-2_000)}),
    ];
    expect(deriveState(events, makeFixtureSeason(), NOW)).toBe("filter-moment");
  });

  it("returns post-filter for the ~30s after the filter-moment ends", () => {
    const events: TickerEvent[] = [
      makeFixtureEvent({type: "FILTER_FIRED", timestamp: isoDelta(-15_000)}),
    ];
    expect(deriveState(events, makeFixtureSeason(), NOW)).toBe("post-filter");
  });

  it("returns pre-filter when nextCutAt is within 10 minutes", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(5 * 60_000)});
    expect(deriveState([], season, NOW)).toBe("pre-filter");
  });

  it("returns high-activity once enough recent events are buffered", () => {
    const events = Array.from({length: 6}, (_, i) =>
      makeFixtureEvent({id: i + 1, timestamp: isoDelta(-2000 - i * 1000)}),
    );
    const season = makeFixtureSeason({nextCutAt: isoDelta(8 * 3600_000)});
    expect(deriveState(events, season, NOW)).toBe("high-activity");
  });

  it("does not enter pre-filter when the season is settled", () => {
    const season = makeFixtureSeason({nextCutAt: isoDelta(2 * 60_000), phase: "settled"});
    expect(deriveState([], season, NOW)).toBe("normal");
  });
});

describe("ArenaTicker rendering", () => {
  it("renders an empty-state placeholder when there are no events", () => {
    render(<ArenaTicker events={[]} season={makeFixtureSeason()} />);
    expect(screen.getByText(/waiting for the next move/i)).toBeTruthy();
  });

  it("renders the filter-moment headline when forced", () => {
    const events: TickerEvent[] = [
      makeFixtureEvent({type: "FILTER_FIRED", message: "🔻 $RUG has been filtered"}),
    ];
    render(<ArenaTicker events={events} season={makeFixtureSeason()} forceState="filter-moment" />);
    expect(screen.getByText(/RUG/i)).toBeTruthy();
  });

  it("renders the pre-filter countdown badge when forced", () => {
    render(
      <ArenaTicker
        events={[]}
        season={makeFixtureSeason({nextCutAt: new Date(Date.now() + 90_000).toISOString()})}
        forceState="pre-filter"
      />,
    );
    expect(screen.getByText(/FILTER IN/i)).toBeTruthy();
  });
});
