/// Epic 1.19 regression — tile mini-bar labels match spec §6.6 (locked
/// 2026-05-05).
///
/// The five spec-locked component labels:
///   1. Buying activity      (velocity)
///   2. Buyer breadth        (effectiveBuyers — RENAMED from "Real participants"
///                           on 2026-05-05; the old label MUST NOT reappear)
///   3. Liquidity strength   (stickyLiquidity)
///   4. Holder conviction    (retention)
///   5. Distribution health  (holderConcentration)
///
/// `momentum` is intentionally absent from the tile view's component set —
/// the row view's HP-breakdown panel still surfaces it but the tile follows
/// the §6.5 lock (5 active components, holderConcentration replacing
/// momentum in the tile-only display).
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaTile} from "../../src/components/arena/ArenaTile.js";
import type {HpUpdate} from "../../src/hooks/arena/useHpUpdates.js";
import type {TokenResponse} from "../../src/lib/arena/api.js";
import {HP_LABELS} from "../../src/lib/arena/hpLabels.js";

const TOKEN: TokenResponse = {
  token: "0x0000000000000000000000000000000000000099",
  ticker: "$LBL",
  rank: 1,
  hp: 9000,
  status: "FINALIST",
  price: "0.0001",
  priceChange24h: 1.2,
  volume24h: "0",
  liquidity: "1000",
  holders: 500,
  components: {
    velocity: 0.6,
    effectiveBuyers: 0.55,
    stickyLiquidity: 0.7,
    retention: 0.45,
    momentum: 0.5,
  },
  bagLock: {isLocked: false, unlockTimestamp: null, creator: "0x0"} as TokenResponse["bagLock"],
};

const LIVE: HpUpdate = {
  hp: 9000,
  components: {
    velocity: 0.6,
    effectiveBuyers: 0.55,
    stickyLiquidity: 0.7,
    retention: 0.45,
    momentum: 0.5,
    holderConcentration: 0.4,
  },
  weightsVersion: "v4",
  computedAt: 1000,
  trigger: "BLOCK_TICK",
  receivedAtIso: new Date(1_000_000).toISOString(),
};

describe("Epic 1.19 — tile mini-bar labels (spec §6.6 lock)", () => {
  it("HP_LABELS.effectiveBuyers is 'Buyer breadth' (renamed from 'Real participants' 2026-05-05)", () => {
    expect(HP_LABELS.effectiveBuyers).toBe("Buyer breadth");
    // The old label MUST NOT reappear anywhere as a string literal — pin
    // the rename here so a revert breaks at this single point.
    expect((HP_LABELS as Record<string, string>).effectiveBuyers).not.toBe("Real participants");
  });

  it("HP_LABELS.holderConcentration is 'Distribution health' (the 5th locked component)", () => {
    expect(HP_LABELS.holderConcentration).toBe("Distribution health");
  });

  it("renders exactly the 5 spec-locked labels (no momentum, no 'Real participants')", () => {
    const {container} = render(<ArenaTile token={TOKEN} liveHp={LIVE} chain="base" />);
    const labels = Array.from(container.querySelectorAll("[data-component-key] span"))
      .map((el) => el.textContent?.trim())
      .filter((s): s is string => !!s && s.length > 0 && !/^\d/.test(s));
    expect(labels).toContain("Buying activity");
    expect(labels).toContain("Buyer breadth");
    expect(labels).toContain("Liquidity strength");
    expect(labels).toContain("Holder conviction");
    expect(labels).toContain("Distribution health");
    // Negative assertions — the old + retired labels MUST NOT appear.
    expect(labels).not.toContain("Real participants");
    expect(labels).not.toContain("Momentum");
    // Bare field names MUST NOT leak through.
    expect(labels).not.toContain("velocity");
    expect(labels).not.toContain("effectiveBuyers");
    expect(labels).not.toContain("stickyLiquidity");
    expect(labels).not.toContain("retention");
    expect(labels).not.toContain("holderConcentration");
  });

  it("renders exactly 5 mini-bar rows in the tile (no 6th, no 4th)", () => {
    const {container} = render(<ArenaTile token={TOKEN} liveHp={LIVE} chain="base" />);
    const rows = container.querySelectorAll("[data-component-key]");
    expect(rows.length).toBe(5);
  });

  it("renders the 5 labels in spec order (Buying → Buyer → Liquidity → Holder → Distribution)", () => {
    const {container} = render(<ArenaTile token={TOKEN} liveHp={LIVE} chain="base" />);
    const orderedKeys = Array.from(container.querySelectorAll("[data-component-key]"))
      .map((el) => el.getAttribute("data-component-key"));
    expect(orderedKeys).toEqual([
      "velocity",
      "effectiveBuyers",
      "stickyLiquidity",
      "retention",
      "holderConcentration",
    ]);
  });
});
