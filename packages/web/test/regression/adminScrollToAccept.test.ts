/// Audit H-Web-5 (Phase 1, 2026-05-01) regression — admin auto-scroll to
/// accept form on mount-as-PENDING.
///
/// Pre-fix `onScrollToAccept` only fired on user click of the auth-banner CTA.
/// If the user landed on the page with auth.state already PENDING (the
/// typical path: nominator shares the URL via DM), they had to hunt the right
/// column for the form. Pin the useEffect + the AdminTransferForms `pulseAccept`
/// prop wiring so a regression that drops the auto-scroll surfaces in CI.
///
/// Same source-grep pattern as launchCostSnapshot — the page composes ~12
/// hooks and an end-to-end render under wagmi mocks would be brittle.
import * as fs from "node:fs";
import * as path from "node:path";

import {describe, expect, it} from "vitest";

const PAGE_PATH = path.resolve(
  __dirname,
  "../../src/app/token/[address]/admin/page.tsx",
);
const source = fs.readFileSync(PAGE_PATH, "utf8");

describe("admin auto-scroll on mount-as-PENDING (Audit H-Web-5)", () => {
  it("uses an effect that triggers on auth.state becoming PENDING", () => {
    expect(source).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?if\s*\(auth\.state\s*!==\s*"PENDING"\)/);
    // Effect must depend on auth.state (otherwise it only fires on first
    // mount, missing the DISCONNECTED → PENDING transition after the user
    // connects their wallet).
    expect(source).toMatch(/\}\s*,\s*\[auth\.state\]\)/);
  });

  it("calls scrollIntoView with smooth + center", () => {
    expect(source).toMatch(
      /acceptAnchorRef\.current\.scrollIntoView\(\s*\{\s*behavior:\s*"smooth"[^}]*block:\s*"center"/,
    );
  });

  it("pulses the accept form for ~2s on the same trigger (visual anchor)", () => {
    expect(source).toContain("setScrollPulse(true)");
    expect(source).toMatch(/setTimeout\(\s*\(\)\s*=>\s*setScrollPulse\(false\)\s*,\s*2000\)/);
  });

  it("threads pulseAccept into AdminTransferForms only when auth.state === PENDING", () => {
    expect(source).toMatch(
      /pulseAccept=\{scrollPulse\s*&&\s*auth\.state\s*===\s*"PENDING"\}/,
    );
  });

  it("AdminTransferForms wires pulseAccept onto the outer-div ref wrapper", () => {
    const compPath = path.resolve(
      __dirname,
      "../../src/components/admin/AdminTransferForms.tsx",
    );
    const comp = fs.readFileSync(compPath, "utf8");
    expect(comp).toMatch(/data-pulse-accept=\{pulseAccept\s*\?\s*"true"\s*:\s*undefined\}/);
  });
});
