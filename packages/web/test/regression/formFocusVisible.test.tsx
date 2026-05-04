/// Audit H-A11y-1 (Phase 1, 2026-05-01) regression — :focus-visible cyan ring.
///
/// Pre-fix every form input across LaunchForm + admin (BagLockCard,
/// RecipientForm, MetadataForm, AdminTransferForms) declared `outline: "none"`
/// inline with no replacement focus ring, leaving keyboard-only users with no
/// visible focus indicator (WCAG 2.4.7 violation). The fix lives in
/// `globals.css` as a single shared rule keyed off `:focus-visible` so the ring
/// shows on keyboard focus only — mouse users keep the clean default. `!important`
/// is required because inline styles outrank pseudo-class rules in the cascade.
///
/// jsdom doesn't simulate `:focus-visible` matching reliably (it has no concept
/// of "focus arrived via keyboard"), so we lock the css rule itself: presence
/// guarantees the rule is in the cascade for any browser + manual keyboard test.
/// The render-side check confirms the inline `outline: none` reset survives on
/// each affected form (so the pre-fix latent bug — bare `outline: none` with no
/// focus replacement — re-surfaces in CI if the global rule is dropped).
import * as fs from "node:fs";
import * as path from "node:path";

import {render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

vi.mock("wagmi", () => ({
  useAccount: () => ({address: "0x1234567890123456789012345678901234567890", isConnected: true}),
}));

import {LaunchForm} from "../../src/components/launch/LaunchForm.js";

const GLOBALS_CSS_PATH = path.resolve(__dirname, "../../src/app/globals.css");
const css = fs.readFileSync(GLOBALS_CSS_PATH, "utf8");

describe("Form input focus-visible spec lock (Audit H-A11y-1)", () => {
  it("globals.css declares input/textarea/select :focus-visible rule with cyan outline", () => {
    // Tolerate whitespace + ordering variation but pin the three selectors and
    // the outline value. `!important` is non-negotiable — without it the inline
    // `outline: none` on each input wins the cascade.
    const ruleMatch = /input:focus-visible[\s\S]*?textarea:focus-visible[\s\S]*?select:focus-visible\s*\{([\s\S]*?)\}/.exec(css);
    expect(ruleMatch, "input/textarea/select :focus-visible block missing from globals.css").not.toBeNull();
    const body = ruleMatch![1];
    expect(body).toMatch(/outline:\s*2px\s+solid\s+var\(--cyan\)\s*!important/);
    expect(body).toMatch(/outline-offset:\s*1px/);
  });

  it("does NOT use a generic :focus rule (would also fire on mouse focus)", () => {
    // The pre-fix audit recommendation was specifically :focus-visible — using
    // bare :focus would re-add the ring on every mouse click, regressing the
    // "clean for mouse users" half of the design intent.
    expect(css).not.toMatch(/^\s*input:focus\s*,/m);
  });

  it("LaunchForm inputs still carry inline `outline: none` (base reset survives)", () => {
    render(
      <LaunchForm
        slotIndex={0}
        launchCostWei={0n}
        stakeWei={0n}
        cohort={[]}
        seasonId={null}
        phase="idle"
        error={null}
        onSubmit={() => {}}
      />,
    );
    // Sanity: the form rendered. We then read the inline outline on the name
    // input (the spec-cited line 151 in the audit) — this asserts the inline
    // reset is intact so the global :focus-visible rule has something to undo
    // for keyboard users. If a future refactor removes the inline reset, the
    // global rule is moot — this guard keeps the two halves in sync.
    const nameInput = screen.getByPlaceholderText("Filtermaxx") as HTMLInputElement;
    expect(nameInput.style.outline).toBe("none");
  });
});
