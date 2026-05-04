/// UserAvatar — Epic 1.24. The component falls back to a deterministic
/// identicon outside of a WagmiProvider; inside one, it'd query
/// `useEnsName` / `useEnsAvatar` and prefer ENS. We exercise the
/// no-wagmi path here (the typical test-env shape) to guarantee:
///   - identical addresses produce the same identicon SVG
///   - distinct addresses produce visually distinct SVGs
///   - the alt/aria-label is wired through to the rendered element

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {UserAvatar} from "@/components/profile/UserAvatar";

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

describe("UserAvatar (no wagmi context)", () => {
  it("renders an identicon role=img with the address as default aria-label", () => {
    const {container} = render(<UserAvatar address={ADDR_A} />);
    const img = container.querySelector("[role='img']");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("aria-label")).toBe(ADDR_A);
  });

  it("uses provided alt as the aria-label when set", () => {
    const {container} = render(<UserAvatar address={ADDR_A} alt="StarBreaker" />);
    expect(container.querySelector("[role='img']")!.getAttribute("aria-label")).toBe(
      "StarBreaker",
    );
  });

  it("identical addresses → identical SVG content (deterministic)", () => {
    const {container: c1} = render(<UserAvatar address={ADDR_A} />);
    const {container: c2} = render(<UserAvatar address={ADDR_A} />);
    expect(c1.innerHTML).toBe(c2.innerHTML);
  });

  it("distinct addresses → distinct SVG content", () => {
    const {container: c1} = render(<UserAvatar address={ADDR_A} />);
    const {container: c2} = render(<UserAvatar address={ADDR_B} />);
    expect(c1.innerHTML).not.toBe(c2.innerHTML);
  });

  it("size variants change the rendered px", () => {
    const {container: sm} = render(<UserAvatar address={ADDR_A} size="sm" />);
    const {container: xl} = render(<UserAvatar address={ADDR_A} size="xl" />);
    const smPx = (sm.querySelector("[role='img']") as HTMLElement).style.width;
    const xlPx = (xl.querySelector("[role='img']") as HTMLElement).style.width;
    expect(smPx).toBe("24px");
    expect(xlPx).toBe("96px");
  });
});
