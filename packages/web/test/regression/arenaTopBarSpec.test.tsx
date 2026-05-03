/// Audit H-Arena-5 + H-Arena-6 (Phase 1, 2026-05-01) regression — top-bar spec.
///
/// Two sibling findings, one rendered surface — kept in one test file so a
/// regression to either lights up the same suite:
///   • H-Arena-5: Pill padding 5×11 / bg 12% / border 40% (was 3×10 / 10% / 33%)
///   • H-Arena-6: Wordmark renders `filter` (white) + `.fun` (pink), not a
///     single white string.
import {render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

// Audit M-Ux-1 (Phase 1, 2026-05-03): ArenaTopBar now renders a wallet
// connect button via wagmi hooks. These tests don't care about wallet
// state — they assert top-bar visual spec — so mock the hooks at the
// module boundary so a missing WagmiProvider doesn't crash the render.
vi.mock("wagmi", () => ({
  useAccount: () => ({address: undefined, isConnected: false}),
  useConnect: () => ({connect: () => {}, connectors: [], status: "idle"}),
  useDisconnect: () => ({disconnect: () => {}}),
}));

import {ArenaTopBar} from "../../src/components/arena/ArenaTopBar.js";
import type {SeasonResponse} from "../../src/lib/arena/api.js";
import {C} from "../../src/lib/tokens.js";

const season: SeasonResponse = {
  seasonId: 7,
  phase: "competition",
  launchCount: 12,
  maxLaunches: 12,
  nextCutAt: new Date(Date.now() + 3_600_000).toISOString(),
  finalSettlementAt: new Date(Date.now() + 86_400_000).toISOString(),
  championPool: "14.82",
  polReserve: "6.42",
};

describe("ArenaTopBar wordmark spec lock (Audit H-Arena-6)", () => {
  it("renders `filter` in C.text and `.fun` in C.pink (split into two coloured spans)", () => {
    render(<ArenaTopBar season={season} liveStatus="open" />);
    const filter = screen.getByText("filter") as HTMLElement;
    const fun = screen.getByText(".fun") as HTMLElement;
    expect(filter.style.color).toBe(hexToRgb(C.text));
    expect(fun.style.color).toBe(hexToRgb(C.pink));
  });
});

describe("ArenaTopBar LIVE-pill spec lock (Audit H-Arena-5)", () => {
  it("LIVE pill uses spec padding 5px 11px (not pre-fix 3px 10px)", () => {
    render(<ArenaTopBar season={season} liveStatus="open" />);
    const pill = screen.getByText(/^LIVE$/).closest("span") as HTMLElement;
    expect(pill.style.padding).toBe("5px 11px");
  });

  it("LIVE pill bg uses 12% alpha (`1f`), border uses 40% alpha (`66`)", () => {
    render(<ArenaTopBar season={season} liveStatus="open" />);
    const pill = screen.getByText(/^LIVE$/).closest("span") as HTMLElement;
    // Background: ${color}1f → jsdom serialises as rgba(r, g, b, ~0.12).
    expectAlphaWithin(pill.style.background, C.green, 0x1f);
    // Border: 1px solid ${color}66 → jsdom serialises as rgba(r, g, b, ~0.40).
    expectAlphaWithin(pill.style.border, C.green, 0x66);
  });
});

function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`hexToRgb: invalid ${hex}`);
  const [, r, g, b] = m;
  return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`;
}

/// jsdom strips trailing zeros from rgba alpha (`0.4`, not `0.40`) and rounds
/// to varying precision across versions, so a literal-string `toContain` is
/// brittle. Parse the rgba() out of the style string and assert RGB equality
/// + alpha within ±0.01 of the expected `alpha255 / 255`.
function expectAlphaWithin(styleStr: string, hex: string, alpha255: number): void {
  const rgbaRe = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/;
  const m = rgbaRe.exec(styleStr.toLowerCase());
  if (!m) throw new Error(`expected rgba(...) in style "${styleStr}", found none`);
  const [, r, g, b, a] = m;
  const hexM = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!hexM) throw new Error(`expectAlphaWithin: invalid hex ${hex}`);
  expect(parseInt(r, 10)).toBe(parseInt(hexM[1], 16));
  expect(parseInt(g, 10)).toBe(parseInt(hexM[2], 16));
  expect(parseInt(b, 10)).toBe(parseInt(hexM[3], 16));
  expect(Math.abs(parseFloat(a) - alpha255 / 255)).toBeLessThanOrEqual(0.01);
}
