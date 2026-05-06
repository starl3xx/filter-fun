/// CreatedTokensList cross-links — Epic 1.27 (spec §36.1.6, §36.1.2).
///
/// Pins the routing rules:
///   FILTERED          → /graveyard/<address>
///   WEEKLY_WINNER+    → /w/<address>
///   ACTIVE / unknown  → /token/<address>/admin (legacy creator console)

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {CreatedTokensList} from "@/components/profile/CreatedTokensList";
import type {ProfileCreatedToken} from "@/lib/arena/api";

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ADDR_W = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const ADDR_F = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const ADDR_Q = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;

function tok(overrides: Partial<ProfileCreatedToken>): ProfileCreatedToken {
  return {
    token: ADDR_A,
    ticker: "$AAA",
    seasonId: 7,
    rank: 0,
    status: "ACTIVE",
    launchedAt: new Date("2026-04-30T00:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("CreatedTokensList cross-links", () => {
  it("ACTIVE token links to /token/<address>/admin (legacy)", () => {
    const {container} = render(
      <CreatedTokensList tokens={[tok({token: ADDR_A, status: "ACTIVE"})]} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`/token/${ADDR_A}/admin`);
  });

  it("FILTERED token links to /graveyard/<address> (Epic 1.25)", () => {
    const {container} = render(
      <CreatedTokensList tokens={[tok({token: ADDR_F, status: "FILTERED"})]} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`/graveyard/${ADDR_F}`);
  });

  it("WEEKLY_WINNER token links to /w/<address> (Epic 1.26)", () => {
    const {container} = render(
      <CreatedTokensList tokens={[tok({token: ADDR_W, status: "WEEKLY_WINNER"})]} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`/w/${ADDR_W}`);
  });

  it("QUARTERLY_FINALIST token links to /w/<address>", () => {
    const {container} = render(
      <CreatedTokensList tokens={[tok({token: ADDR_Q, status: "QUARTERLY_FINALIST"})]} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`/w/${ADDR_Q}`);
  });

  it("QUARTERLY_CHAMPION token links to /w/<address>", () => {
    const {container} = render(
      <CreatedTokensList tokens={[tok({token: ADDR_Q, status: "QUARTERLY_CHAMPION"})]} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`/w/${ADDR_Q}`);
  });

  it("renders empty state when there are no tokens", () => {
    const {container} = render(<CreatedTokensList tokens={[]} />);
    expect(container.textContent).toContain("No tokens created yet");
  });
});
