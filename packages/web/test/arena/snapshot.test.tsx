/// Visual snapshot test for the Arena page chrome.
///
/// jsdom doesn't run media queries, so the snapshots capture the desktop
/// DOM directly. The mobile-specific behavior (bottom-sheet, single-column
/// stack) is exercised by the component-level Leaderboard / page tests; the
/// snapshot's job is to lock down the *structure* of the page so a refactor
/// that drops a section is caught immediately.

import {render} from "@testing-library/react";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";

// Audit M-Ux-1 (Phase 1, 2026-05-03): ArenaTopBar now hosts a wallet
// connect button that calls wagmi hooks. Snapshot tests render without a
// WagmiProvider — mock at the module boundary so the snapshot captures
// the disconnected-state DOM (the most common surface).
vi.mock("wagmi", () => ({
  useAccount: () => ({address: undefined, isConnected: false}),
  useConnect: () => ({connect: () => {}, connectors: [], status: "idle"}),
  useDisconnect: () => ({disconnect: () => {}}),
}));

import {ArenaLeaderboard} from "@/components/arena/ArenaLeaderboard";
import {ArenaTopBar} from "@/components/arena/ArenaTopBar";

import {makeFixtureCohort, makeFixtureSeason} from "./fixtures";

// Pin wall-clock so countdown timers / live indicators are deterministic in
// snapshots — without this, every CI run produces a fresh "Next cut in" diff.
const FIXED_NOW = new Date("2026-04-30T12:00:00.000Z");

describe("Arena visual snapshots", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("ArenaTopBar matches snapshot", () => {
    const season = makeFixtureSeason({
      nextCutAt: "2099-01-01T00:00:00.000Z",
      finalSettlementAt: "2099-01-08T00:00:00.000Z",
    });
    const {asFragment} = render(<ArenaTopBar season={season} liveStatus="open" />);
    expect(asFragment()).toMatchSnapshot();
  });

  it("ArenaLeaderboard with 12-token cohort matches snapshot", () => {
    const {asFragment} = render(
      <ArenaLeaderboard
        tokens={makeFixtureCohort()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
      />,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("ArenaLeaderboard hides cut line in launch phase", () => {
    const {asFragment} = render(
      <ArenaLeaderboard
        tokens={makeFixtureCohort()}
        trendBuffers={new Map()}
        selectedAddress={null}
        onSelect={() => {}}
        hideCutLine
      />,
    );
    expect(asFragment()).toMatchSnapshot();
  });
});
