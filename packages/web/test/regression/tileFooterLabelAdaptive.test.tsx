/// Epic 1.19 — bugbot finding regression (PR #91, commit 96dcbeb).
///
/// The third footer slot on `ArenaTile` is bivalent: it shows the 24h
/// percent-change when there's price movement, otherwise falls through
/// to a "time since last trade" derived from the last HP recompute. The
/// label was hardcoded `"24h"` even when the value was a `tradeAge`
/// string like `"3m"`, producing the misleading readout `"24h 3m"`.
///
/// Post-fix: label adapts to whichever metric is actually being shown.
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaTile} from "../../src/components/arena/ArenaTile.js";
import type {HpUpdate} from "../../src/hooks/arena/useHpUpdates.js";
import type {TokenResponse} from "../../src/lib/arena/api.js";

function tokenWithChange(priceChange24h: number): TokenResponse {
  return {
    token: "0x0000000000000000000000000000000000000001",
    ticker: "$LBL",
    rank: 1,
    hp: 9000,
    status: "FINALIST",
    price: "0.0001",
    priceChange24h,
    volume24h: "0",
    liquidity: "1000",
    holders: 100,
    components: {
      velocity: 0.5,
      effectiveBuyers: 0.5,
      stickyLiquidity: 0.5,
      retention: 0.5,
      momentum: 0.5,
    },
    bagLock: {isLocked: false, unlockTimestamp: null, creator: "0x0"} as TokenResponse["bagLock"],
  };
}

const LIVE_HP_NOW: HpUpdate = {
  hp: 9000,
  components: {
    velocity: 0.5,
    effectiveBuyers: 0.5,
    stickyLiquidity: 0.5,
    retention: 0.5,
    momentum: 0.5,
    holderConcentration: 0.5,
  },
  weightsVersion: "v4",
  computedAt: Math.floor(Date.now() / 1000) - 180, // 3m ago
  trigger: "SWAP",
  receivedAtIso: new Date().toISOString(),
};

describe("Epic 1.19 — adaptive footer label (24h vs Last trade)", () => {
  it("renders '24h' label when priceChange24h is non-zero", () => {
    const {container} = render(
      <ArenaTile token={tokenWithChange(2.5)} liveHp={LIVE_HP_NOW} chain="base" />,
    );
    const labels = Array.from(container.querySelectorAll("span"))
      .map((el) => el.textContent?.trim())
      .filter((s): s is string => !!s);
    expect(labels).toContain("24h");
    expect(labels).not.toContain("Last trade");
  });

  it("renders 'Last trade' label when priceChange24h is zero (slot displays trade age instead)", () => {
    const {container} = render(
      <ArenaTile token={tokenWithChange(0)} liveHp={LIVE_HP_NOW} chain="base" />,
    );
    const labels = Array.from(container.querySelectorAll("span"))
      .map((el) => el.textContent?.trim())
      .filter((s): s is string => !!s);
    expect(labels).toContain("Last trade");
    expect(labels).not.toContain("24h");
  });

  it("never renders '24h' next to a trade-age value (the readout pattern that prompted the fix)", () => {
    const {container} = render(
      <ArenaTile token={tokenWithChange(0)} liveHp={LIVE_HP_NOW} chain="base" />,
    );
    // The pre-fix shape was "24h" + "3m" siblings. Post-fix the label is
    // "Last trade" so a "24h"/"3m" adjacency is impossible. Pin it as a
    // negative-grep on the rendered HTML so a future relapse to the
    // hardcoded label would surface here.
    expect(container.innerHTML).not.toMatch(/24h[\s\S]{0,80}\d+[smh]/);
  });
});
