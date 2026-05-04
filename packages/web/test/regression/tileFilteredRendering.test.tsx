/// Epic 1.19 regression — filtered token rendering + sort-to-bottom.
///
/// Spec §19.6.1: filtered tokens render with a muted palette (opacity
/// 0.6 on the tile container) and ALWAYS sort to the bottom of the
/// grid regardless of the `arena_sort` selection — the dropdown picks
/// the order amongst surviving tokens, then filtered are appended.
/// The status pill itself is the existing red FILTERED ▼ badge from
/// the row view (per brand §32.4 — U+25BC, not the 🔻 emoji).
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {ArenaTile} from "../../src/components/arena/ArenaTile.js";
import {sortTokensForTile} from "../../src/components/arena/ArenaSortDropdown.js";
import type {TokenResponse} from "../../src/lib/arena/api.js";

function tokenAt(rank: number, hp: number, status: TokenResponse["status"], suffix: string): TokenResponse {
  return {
    token: `0x${suffix.padStart(40, "0")}` as `0x${string}`,
    ticker: `$T${rank}`,
    rank,
    hp,
    status,
    price: "0.0001",
    priceChange24h: 0,
    volume24h: "0",
    liquidity: "1000",
    holders: 100 + rank,
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

describe("Epic 1.19 — filtered tile rendering", () => {
  it("muted palette: opacity 0.6 on the tile container", () => {
    const t = tokenAt(11, 1200, "FILTERED", "1");
    const {container} = render(<ArenaTile token={t} chain="base" />);
    const tile = container.querySelector("[data-tile-token]") as HTMLElement;
    expect(tile).not.toBeNull();
    expect(tile.style.opacity).toBe("0.6");
  });

  it("renders the FILTERED status with the literal ▼ glyph (not the 🔻 emoji)", () => {
    const t = tokenAt(11, 1200, "FILTERED", "2");
    const {container} = render(<ArenaTile token={t} chain="base" />);
    const tile = container.querySelector("[data-tile-token]") as HTMLElement;
    // The StatusBadge renders the icon; tile must include it. The badge
    // also enforces the same constraint via statusBadgeAtRisk.test.tsx,
    // but pinning it on the tile guards against a future copy-paste that
    // reintroduces the emoji at the tile layer.
    expect(tile.textContent).toContain("▼");
    expect(tile.textContent).not.toContain("🔻");
  });
});

describe("Epic 1.19 — filtered tokens sort to the bottom regardless of arena_sort", () => {
  const cohort: TokenResponse[] = [
    tokenAt(1, 9000, "FINALIST", "a"),
    tokenAt(2, 8200, "SAFE",     "b"),
    tokenAt(11, 7500, "FILTERED", "c"), // High HP but filtered → must sink.
    tokenAt(3, 7000, "AT_RISK",  "d"),
    tokenAt(12, 1000, "FILTERED", "e"),
  ];

  it("hp-desc: filtered tokens go last even though their HP would sort high", () => {
    const sorted = sortTokensForTile(cohort, "hp-desc");
    expect(sorted.map((t) => t.status)).toEqual([
      "FINALIST",
      "SAFE",
      "AT_RISK",
      "FILTERED",
      "FILTERED",
    ]);
  });

  it("status: surviving tokens by status; filtered still last", () => {
    const sorted = sortTokensForTile(cohort, "status");
    expect(sorted.map((t) => t.status)).toEqual([
      "FINALIST",
      "SAFE",
      "AT_RISK",
      "FILTERED",
      "FILTERED",
    ]);
  });

  it("activity (no meta): falls back to rank order, filtered still last", () => {
    const sorted = sortTokensForTile(cohort, "activity");
    // First three are surviving rank-ordered; last two are filtered (also
    // rank-ordered amongst themselves by HP-desc).
    expect(sorted.slice(0, 3).map((t) => t.rank)).toEqual([1, 2, 3]);
    expect(sorted.slice(3).every((t) => t.status === "FILTERED")).toBe(true);
  });

  it("delta (no meta): same fallback shape; filtered still last", () => {
    const sorted = sortTokensForTile(cohort, "delta");
    expect(sorted.slice(3).every((t) => t.status === "FILTERED")).toBe(true);
  });
});
