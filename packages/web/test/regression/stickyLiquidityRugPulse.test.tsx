/// Epic 1.19 regression — stickyLiquidity emphasis + soft-rug pulse.
///
/// Spec §6.4.3 calls stickyLiquidity "the protocol's primary anti-extraction
/// signal". The tile gives it three special treatments:
///   1. The bar is thicker (6px) than the other four components (4px).
///   2. The label carries a tooltip: "Real liquidity that hasn't fled.
///      Anti-rug signal."
///   3. The bar gets a single-shot red pulse (`ff-arena-tile-rug-pulse`)
///      whenever stickyLiquidity drops more than 10pp between two
///      HP_UPDATED frames — the visual alarm for an in-progress soft-rug.
///
/// The pulse logic lives in `ArenaTileGrid` (it tracks previous values
/// across renders). We pin the bar emphasis on `ArenaTile` directly and
/// the drop-detection through a two-render harness on the grid.
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {
  ArenaTile,
  STICKY_LIQUIDITY_RUG_THRESHOLD_PP,
  STICKY_LIQUIDITY_TOOLTIP,
} from "../../src/components/arena/ArenaTile.js";
import {ArenaTileGrid} from "../../src/components/arena/ArenaTileGrid.js";
import type {HpUpdate} from "../../src/hooks/arena/useHpUpdates.js";
import type {TokenResponse} from "../../src/lib/arena/api.js";

const TOKEN: TokenResponse = {
  token: "0x0000000000000000000000000000000000000001",
  ticker: "$RUG",
  rank: 3,
  hp: 6500,
  status: "AT_RISK",
  price: "0.0001",
  priceChange24h: -2.4,
  volume24h: "0",
  liquidity: "1000",
  holders: 220,
  components: {
    velocity: 0.7,
    effectiveBuyers: 0.55,
    stickyLiquidity: 0.85,
    retention: 0.4,
    momentum: 0.6,
  },
  bagLock: {isLocked: false, unlockTimestamp: null, creator: "0x0"} as TokenResponse["bagLock"],
};

function liveHpFor(stickyLiquidity: number, computedAt: number): HpUpdate {
  return {
    hp: 6500,
    components: {
      velocity: 0.7,
      effectiveBuyers: 0.55,
      stickyLiquidity,
      retention: 0.4,
      momentum: 0.6,
      holderConcentration: 0.5,
    },
    weightsVersion: "v4",
    computedAt,
    trigger: "SWAP",
    receivedAtIso: new Date(computedAt * 1000).toISOString(),
  };
}

describe("Epic 1.19 — stickyLiquidity emphasis", () => {
  it("renders the tooltip copy on the stickyLiquidity label", () => {
    const {container} = render(<ArenaTile token={TOKEN} chain="base" />);
    const labelEl = container.querySelector('[data-component-key="stickyLiquidity"] [title]');
    expect(labelEl).not.toBeNull();
    expect(labelEl!.getAttribute("title")).toBe(STICKY_LIQUIDITY_TOOLTIP);
  });

  it("renders the stickyLiquidity bar at 6px (vs 4px for other components)", () => {
    const {container} = render(<ArenaTile token={TOKEN} chain="base" />);
    const stickyBar = container.querySelector('[data-component-bar="stickyLiquidity"]') as HTMLElement;
    const velocityBar = container.querySelector('[data-component-bar="velocity"]') as HTMLElement;
    expect(stickyBar).not.toBeNull();
    expect(velocityBar).not.toBeNull();
    expect(stickyBar.style.height).toBe("6px");
    expect(velocityBar.style.height).toBe("4px");
  });

  it("data-component-emphasized marks ONLY the stickyLiquidity bar", () => {
    const {container} = render(<ArenaTile token={TOKEN} chain="base" />);
    const emphasized = container.querySelectorAll("[data-component-emphasized]");
    expect(emphasized.length).toBe(1);
    expect((emphasized[0] as HTMLElement).getAttribute("data-component-bar")).toBe("stickyLiquidity");
  });
});

describe("Epic 1.19 — stickyLiquidity soft-rug pulse on >10pp drop", () => {
  it("threshold constant is exactly 10pp (spec §6.4.3 lock)", () => {
    expect(STICKY_LIQUIDITY_RUG_THRESHOLD_PP).toBe(10);
  });

  it("fires the rug-pulse class when stickyLiquidity drops > threshold between two renders", () => {
    const live1 = liveHpFor(0.9, 1000);
    const hpByAddress1 = new Map([[TOKEN.token.toLowerCase(), live1]]);
    const fresh = new Map([[TOKEN.token.toLowerCase(), 1000]]);

    // First render seeds the previous-stickyLiquidity at 0.9 (= 90pp).
    const {container, rerender} = render(
      <ArenaTileGrid
        tokens={[TOKEN]}
        hpByAddress={hpByAddress1}
        freshHpUpdateSeqByAddress={fresh}
        selectedAddress={null}
        onSelect={() => {}}
        chain="base"
      />,
    );

    // Pre-drop the bar should NOT carry the pulse class — there's no prior
    // frame to diff against, so the seq stays at 0.
    expect(
      container.querySelector('[data-component-bar="stickyLiquidity"].ff-arena-tile-rug-pulse'),
    ).toBeNull();

    // Second render: stickyLiquidity drops to 0.7 (= 70pp). Delta = 20pp,
    // greater than the 10pp threshold — the bar must pick up the pulse class.
    const live2 = liveHpFor(0.7, 1500);
    const hpByAddress2 = new Map([[TOKEN.token.toLowerCase(), live2]]);
    const fresh2 = new Map([[TOKEN.token.toLowerCase(), 1500]]);
    rerender(
      <ArenaTileGrid
        tokens={[TOKEN]}
        hpByAddress={hpByAddress2}
        freshHpUpdateSeqByAddress={fresh2}
        selectedAddress={null}
        onSelect={() => {}}
        chain="base"
      />,
    );

    const pulsedBar = container.querySelector(
      '[data-component-bar="stickyLiquidity"].ff-arena-tile-rug-pulse',
    );
    expect(pulsedBar).not.toBeNull();
  });

  it("does NOT fire the pulse on a sub-threshold drop (5pp)", () => {
    const live1 = liveHpFor(0.9, 1000);
    const hpByAddress1 = new Map([[TOKEN.token.toLowerCase(), live1]]);
    const fresh = new Map([[TOKEN.token.toLowerCase(), 1000]]);

    const {container, rerender} = render(
      <ArenaTileGrid
        tokens={[TOKEN]}
        hpByAddress={hpByAddress1}
        freshHpUpdateSeqByAddress={fresh}
        selectedAddress={null}
        onSelect={() => {}}
        chain="base"
      />,
    );

    const live2 = liveHpFor(0.85, 1500); // 5pp drop — below threshold.
    const hpByAddress2 = new Map([[TOKEN.token.toLowerCase(), live2]]);
    const fresh2 = new Map([[TOKEN.token.toLowerCase(), 1500]]);
    rerender(
      <ArenaTileGrid
        tokens={[TOKEN]}
        hpByAddress={hpByAddress2}
        freshHpUpdateSeqByAddress={fresh2}
        selectedAddress={null}
        onSelect={() => {}}
        chain="base"
      />,
    );

    expect(
      container.querySelector('[data-component-bar="stickyLiquidity"].ff-arena-tile-rug-pulse'),
    ).toBeNull();
  });
});
