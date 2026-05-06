/// Footer canonical channels — Epic 1.28 spec §32.5 surface.
///
/// Pins the channel list (URLs + labels) and the pathname-gating logic in
/// `<FooterSlot>` so a future page added under `/admin/...` doesn't leak the
/// canonical block onto an admin surface, and a regression to the wrong
/// email or wrong GitHub URL surfaces in CI rather than in the wild.

import {render} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

import {CANONICAL_CHANNELS, CANONICAL_TAGLINE, FooterCanonical} from "../../src/components/FooterCanonical.js";
import {FooterSlot} from "../../src/components/FooterSlot.js";

const mockUsePathname = vi.fn(() => null as string | null);
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

describe("FooterCanonical channels (spec §32.5)", () => {
  it("renders the locked tagline 'Get filtered or get funded ▼'", () => {
    const {container} = render(<FooterCanonical />);
    expect(container.textContent).toContain(CANONICAL_TAGLINE);
    expect(container.textContent).toContain("Get filtered or get funded ▼");
  });

  it("renders all six canonical channels with locked URLs (spec §32.5)", () => {
    const {container} = render(<FooterCanonical />);
    const links = Array.from(container.querySelectorAll("a")).map((a) => ({
      href: a.getAttribute("href"),
      text: a.textContent ?? "",
    }));
    expect(links).toHaveLength(6);
    // Direct lookups for each spec'd channel — order-independent so a future
    // re-ordering doesn't break the test, but the URLs themselves are locked.
    expect(links).toContainEqual({href: "https://filter.fun", text: "filter.fun"});
    expect(links).toContainEqual({href: "https://docs.filter.fun", text: "docs.filter.fun"});
    expect(links).toContainEqual({href: "https://api.filter.fun", text: "api.filter.fun"});
    expect(links).toContainEqual({href: "https://x.com/filterdotfun", text: "@filterdotfun"});
    expect(links).toContainEqual({href: "https://github.com/starl3xx/filter-fun", text: "github.com/starl3xx/filter-fun"});
    expect(links).toContainEqual({href: "mailto:starl3xx@filter.fun", text: "starl3xx@filter.fun"});
  });

  it("locks the email to starl3xx@filter.fun (NOT security@filter.fun per spec §32.5)", () => {
    const emails = CANONICAL_CHANNELS.filter((c) => c.href.startsWith("mailto:")).map((c) => c.href);
    expect(emails).toContain("mailto:starl3xx@filter.fun");
    expect(emails).not.toContain("mailto:security@filter.fun");
  });

  it("uses api.filter.fun (NOT the railway.app fallback) for the API channel", () => {
    const apiChannel = CANONICAL_CHANNELS.find((c) => c.label === "api.filter.fun");
    expect(apiChannel?.href).toBe("https://api.filter.fun");
    const allHrefs = CANONICAL_CHANNELS.map((c) => c.href).join(" ");
    expect(allHrefs).not.toContain("railway.app");
  });

  it("external links open in a new tab with rel=noopener", () => {
    const {container} = render(<FooterCanonical />);
    const externalLinks = Array.from(container.querySelectorAll("a")).filter((a) =>
      (a.getAttribute("href") ?? "").startsWith("http"),
    );
    for (const a of externalLinks) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel") ?? "").toContain("noopener");
    }
  });
});

describe("FooterSlot pathname gating", () => {
  const SHOULD_SHOW = ["/", "/launch", "/graveyard", "/graveyard/0xabc", "/winners", "/w/alice", "/p/0xabc"];
  const SHOULD_HIDE = ["/operator", "/operator/queue", "/token/0xabc/admin"];

  it.each(SHOULD_SHOW)("renders on user-facing pathname %s", (pathname) => {
    mockUsePathname.mockReturnValueOnce(pathname);
    const {queryByTestId} = render(<FooterSlot />);
    expect(queryByTestId("footer-canonical")).not.toBeNull();
  });

  it.each(SHOULD_HIDE)("skips the focused workflow surface %s", (pathname) => {
    mockUsePathname.mockReturnValueOnce(pathname);
    const {queryByTestId} = render(<FooterSlot />);
    expect(queryByTestId("footer-canonical")).toBeNull();
  });

  it("returns null when usePathname is null (initial server render)", () => {
    mockUsePathname.mockReturnValueOnce(null);
    const {queryByTestId} = render(<FooterSlot />);
    expect(queryByTestId("footer-canonical")).toBeNull();
  });
});
