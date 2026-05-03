/// PolishA11yPassTest — Audit polish pass (Phase 1, 2026-05-03)
///
/// Bundled regressions for the code-touching items in the a11y polish PR.
/// Each test maps to one finding in audit/2026-05-PHASE-1-AUDIT/a11y.md so
/// a future revert that drops the change surfaces with the audit ID in the
/// failure label.
///
/// Findings covered:
///   - M-A11y-1: acknowledged checkbox carries explicit id + htmlFor
///     pairing (WCAG 1.3.1) instead of relying on implicit nesting.
///   - M-A11y-2: link inputs (Website / X·Twitter / Farcaster) wrapped in
///     visible labels via `<LinkField>` — drops the aria-label-only
///     fallback that was invisible to sighted users with cognitive /
///     visual disabilities.
///   - L-A11y-1: ErrorNotice carries `role="alert"` + `aria-live="polite"`
///     so screen-reader users hear field-validation + post-pin errors.
import {render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

vi.mock("wagmi", () => ({
  useAccount: () => ({address: "0x1234567890123456789012345678901234567890", isConnected: true}),
}));

import {LaunchForm, type LaunchFormProps} from "../../src/components/launch/LaunchForm.js";
import type {TokenResponse} from "../../src/lib/arena/api.js";

// Minimal smoke-render scaffolding — the form has heavy wagmi imports but
// the only hook it actually calls is `useAccount`; vitest's auto-mocked
// wagmi (already configured by test/setup.ts) returns a disconnected default
// which is exactly what these a11y assertions want.
function mkProps(overrides: Partial<LaunchFormProps> = {}): LaunchFormProps {
  return {
    slotIndex: 0,
    launchCostWei: 1n,
    stakeWei: 0n,
    cohort: [] as TokenResponse[],
    phase: "idle",
    error: null,
    onSubmit: () => undefined,
    ...overrides,
  };
}

// M-A11y-1 -----------------------------------------------------------------
//
// Pre-fix: the acknowledged checkbox was inside an implicit-nesting label
// with no id/htmlFor. Some screen reader / VoiceOver combinations don't
// pick up the implicit association reliably (WCAG 1.3.1).
describe("M-A11y-1: acknowledged checkbox uses explicit id + htmlFor pairing", () => {
  it("the checkbox input has the id 'acknowledge-filtered'", () => {
    render(<LaunchForm {...mkProps()} />);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.id).toBe("acknowledge-filtered");
  });

  it("there is a <label> in the DOM whose htmlFor matches the checkbox id", () => {
    const {container} = render(<LaunchForm {...mkProps()} />);
    const label = container.querySelector("label[for='acknowledge-filtered']") as HTMLLabelElement | null;
    expect(label).not.toBeNull();
    // The label should still wrap the visible "I understand most tokens
    // get filtered" copy so the click target stays large.
    expect(label?.textContent ?? "").toMatch(/most tokens get filtered/i);
  });
});

// M-A11y-2 -----------------------------------------------------------------
//
// Pre-fix: the 3 link inputs (Website / X·Twitter / Farcaster) used
// `aria-label` only — invisible to sighted users with cognitive / visual
// disabilities and a fragile fallback per WCAG 1.3.1. Post-fix: each input
// wraps in a `<LinkField>` that renders a visible mono-uppercase label
// above the input AND ties them via useId().
describe("M-A11y-2: link inputs have visible labels (not aria-label only)", () => {
  it("each link input is reachable via getByLabelText with its visible label text", () => {
    render(<LaunchForm {...mkProps()} />);
    // getByLabelText exercises the label/htmlFor pairing — passes only if
    // the label is visible AND associated to the input via id.
    expect(screen.getByLabelText(/^website$/i)).toBeDefined();
    expect(screen.getByLabelText(/x \/ twitter/i)).toBeDefined();
    expect(screen.getByLabelText(/^farcaster$/i)).toBeDefined();
  });

  it("link inputs no longer carry aria-label (visible labels supersede)", () => {
    const {container} = render(<LaunchForm {...mkProps()} />);
    const inputs = container.querySelectorAll("input[type='url'], input[type='text']");
    // Find the website / twitter / farcaster inputs by placeholder.
    const website = container.querySelector("input[placeholder='yourdomain.com']") as HTMLInputElement | null;
    const twitter = container.querySelector("input[placeholder='@handle']") as HTMLInputElement | null;
    const farcaster = container.querySelector("input[placeholder='username.eth']") as HTMLInputElement | null;
    expect(website).not.toBeNull();
    expect(twitter).not.toBeNull();
    expect(farcaster).not.toBeNull();
    // Each should NOT carry the legacy aria-label — visible label is the
    // canonical accessible name now.
    expect(website?.getAttribute("aria-label")).toBeNull();
    expect(twitter?.getAttribute("aria-label")).toBeNull();
    expect(farcaster?.getAttribute("aria-label")).toBeNull();
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("each LinkField uses a unique id (useId) so multiple instances don't collide", () => {
    const {container} = render(<LaunchForm {...mkProps()} />);
    const labelFors = Array.from(
      container.querySelectorAll("label[for]") as NodeListOf<HTMLLabelElement>,
    ).map((l) => l.getAttribute("for"));
    // The 3 link-field labels should have non-empty unique htmlFor values.
    const linkFieldFors = labelFors.filter((f) => f && f !== "acknowledge-filtered");
    const uniqueFors = new Set(linkFieldFors);
    // At least 3 distinct htmlFor values for the 3 link inputs (other
    // labels may also exist; the set check ensures no collision).
    expect(uniqueFors.size).toBeGreaterThanOrEqual(3);
  });
});

// L-A11y-1 -----------------------------------------------------------------
//
// Pre-fix: ErrorNotice rendered as a bare <div>. The launch form sits
// outside the page-level `aria-live` NoticeCard, so a screen-reader user
// would silently miss field-validation errors and post-pin / post-tx
// errors. Post-fix: role="status" + aria-live="polite".
//
// Bugbot follow-up on PR #74: the earlier draft used `role="alert"` with
// `aria-live="polite"`. `role="alert"` carries an implicit
// `aria-live="assertive"`; overriding with polite produces inconsistent
// SR behaviour. The spec-correct pairing for polite announcements is
// `role="status"` (implicit polite). Pin both the post-fix shape AND the
// absence of the rejected `role="alert"` on the ErrorNotice surface.
describe("L-A11y-1: ErrorNotice carries role=status + aria-live=polite", () => {
  it("a rendered error region has both attributes", () => {
    const {container} = render(
      <LaunchForm {...mkProps({error: "test error message"})} />,
    );
    // Find a <div role="status"> with the error copy.
    const statuses = container.querySelectorAll("[role='status']");
    const errorStatus = Array.from(statuses).find(
      (el) => (el.textContent ?? "").includes("test error message"),
    );
    expect(errorStatus).toBeDefined();
    expect(errorStatus?.getAttribute("aria-live")).toBe("polite");
  });

  it("the rejected role='alert' is no longer on the ErrorNotice region (bugbot fix)", () => {
    const {container} = render(
      <LaunchForm {...mkProps({error: "another test error message"})} />,
    );
    // The error region must not carry role="alert" — that pairing's
    // implicit aria-live="assertive" conflicts with the explicit polite.
    const alerts = Array.from(container.querySelectorAll("[role='alert']"));
    const errorAlert = alerts.find(
      (el) => (el.textContent ?? "").includes("another test error message"),
    );
    expect(errorAlert).toBeUndefined();
  });
});
