/// CreatorChip — verifies the cross-link href and label fallback.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {CreatorChip} from "@/components/profile/CreatorChip";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01" as `0x${string}`;

describe("CreatorChip", () => {
  it("links to /p/<address>", () => {
    const {container} = render(<CreatorChip address={ADDR} />);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`/p/${ADDR}`);
  });

  it("renders shortened address when no label provided", () => {
    const {container} = render(<CreatorChip address={ADDR} />);
    expect(container.textContent).toContain("0xabcd");
    expect(container.textContent).toContain("ef01");
  });

  it("prefers a non-empty explicit label over the address", () => {
    const {container} = render(<CreatorChip address={ADDR} label="StarBreaker" />);
    expect(container.textContent).toContain("StarBreaker");
  });

  it("falls back to address when label is empty string", () => {
    const {container} = render(<CreatorChip address={ADDR} label="" />);
    expect(container.textContent).toContain("0xabcd");
  });
});
