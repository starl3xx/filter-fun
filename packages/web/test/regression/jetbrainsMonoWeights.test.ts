/// Audit M-Arena-1 (Phase 1, 2026-05-01) regression — JetBrains Mono weight set.
///
/// ARENA_SPEC §2.1 mandates 400/500/600/700. Pre-fix layout.tsx loaded 500/700/800
/// (missing 400 + 600, adding the not-in-spec 800). Mono surfaces — countdowns,
/// prices, the RateLimit-Remaining footer chip, every tabular-nums column — fall
/// back to the nearest loaded weight when a non-loaded one is requested, which
/// silently broke type-role hierarchy across every mono-using component.
///
/// We can't introspect the next/font runtime config from a unit test, so we
/// grep the source — the same pattern PR #57 used for the Bricolage weight pin
/// (C-8) and PR #61 used for the CORS exposeHeaders config.
import * as fs from "node:fs";
import * as path from "node:path";

import {describe, expect, it} from "vitest";

const LAYOUT_PATH = path.resolve(__dirname, "../../src/app/layout.tsx");
const source = fs.readFileSync(LAYOUT_PATH, "utf8");

describe("JetBrains Mono weight set spec lock (Audit M-Arena-1)", () => {
  it("loads exactly the 4 spec weights — 400, 500, 600, 700", () => {
    // Match the JetBrains_Mono({...weight: [...]}) call specifically; Bricolage
    // also uses a `weight:` array but for a different font.
    const monoBlockMatch = /JetBrains_Mono\(\{[^}]*weight:\s*(\[[^\]]+\])/s.exec(source);
    expect(monoBlockMatch, "JetBrains_Mono weight: array not found in layout.tsx").not.toBeNull();
    const weightArr = monoBlockMatch![1].replace(/\s/g, "");
    expect(weightArr).toBe('["400","500","600","700"]');
  });

  it('does NOT load weight "800" (was incorrectly added pre-fix; not in spec)', () => {
    const monoBlockMatch = /JetBrains_Mono\(\{[^}]*weight:\s*\[([^\]]+)\]/s.exec(source);
    expect(monoBlockMatch).not.toBeNull();
    expect(monoBlockMatch![1]).not.toContain("800");
  });
});
