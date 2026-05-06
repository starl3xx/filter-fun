/// NearMissChip — Epic 1.27. Pins the wire shape (variant + glyph + label
/// rendering) and the formatMarginHp helper.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {NearMissChip, formatMarginHp} from "@/components/graveyard/NearMissChip";

describe("NearMissChip", () => {
  it("filtered variant renders 'filtered by <margin> HP'", () => {
    const {container} = render(<NearMissChip marginHp={120} variant="filtered" />);
    expect(container.textContent).toContain("filtered by 1.2 HP");
  });

  it("won variant renders 'won by <margin> HP'", () => {
    const {container} = render(<NearMissChip marginHp={240} variant="won" />);
    expect(container.textContent).toContain("won by 2.4 HP");
  });

  it("renders the ▼ glyph for filtered variant (broadcast filter motif, spec design A2)", () => {
    const {container} = render(<NearMissChip marginHp={100} variant="filtered" />);
    expect(container.textContent).toContain("▼");
  });

  it("renders the ▲ glyph for won variant", () => {
    const {container} = render(<NearMissChip marginHp={100} variant="won" />);
    expect(container.textContent).toContain("▲");
  });

  it("never includes the U+1F53B emoji (brand kit v1.0 / spec §32.4)", () => {
    // Codepoint constructed dynamically so the literal U+1F53B never lives
    // in source — Epic 1.28 lint rule fails the build on a literal.
    const HEAVY_TRIANGLE = String.fromCodePoint(0x1f53b);
    const filtered = render(<NearMissChip marginHp={100} variant="filtered" />);
    const won = render(<NearMissChip marginHp={100} variant="won" />);
    expect(filtered.container.textContent).not.toContain(HEAVY_TRIANGLE);
    expect(won.container.textContent).not.toContain(HEAVY_TRIANGLE);
  });
});

describe("formatMarginHp", () => {
  it("renders integer-multiple-of-100 margins without decimals", () => {
    expect(formatMarginHp(0)).toBe("0 HP");
    expect(formatMarginHp(100)).toBe("1 HP");
    expect(formatMarginHp(500)).toBe("5 HP");
    expect(formatMarginHp(1000)).toBe("10 HP");
  });

  it("renders sub-100-HP margins with one decimal", () => {
    expect(formatMarginHp(40)).toBe("0.4 HP");
    expect(formatMarginHp(120)).toBe("1.2 HP");
    expect(formatMarginHp(240)).toBe("2.4 HP");
    expect(formatMarginHp(499)).toBe("5.0 HP"); // rounds via toFixed
  });

  it("0-margin (exactly at cut line) renders cleanly", () => {
    expect(formatMarginHp(0)).toBe("0 HP");
  });
});
