/// Epic 1.19 — bugbot finding regression (PR #91, commit 96dcbeb).
///
/// `useTileSortMeta`'s `prevRef` previously held HP values across an
/// `enabled` flip. Scenario:
///   1. user is in tile mode, `prevRef` populated with HPs from N polls
///   2. user switches to list mode → `enabled = false` → ref is unchanged
///   3. several polls happen; ref is skipped (correct) but stays full
///   4. user switches back to tile mode → useMemo reads stale prev
///   5. "delta" sort computes `|current_hp - stale_old_hp|` → inflated
///      delta → wrong order
///
/// Post-fix: the disable-side useEffect calls `prevRef.current.clear()`
/// so a re-enable starts from a clean slate. Source-grep is the right
/// regression anchor — the hook is private to `page.tsx` and exporting
/// it just for testing would muddy the surface area.
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pageSrc = readFileSync(path.join(repoRoot, "src/app/page.tsx"), "utf-8");

describe("Epic 1.19 — useTileSortMeta clears prevRef on disable", () => {
  it("the disable-side useEffect calls `prevRef.current.clear()`", () => {
    // Pre-fix: `if (!enabled) return;` skipped both the write AND the
    // clear → ref leaked across the flip. Post-fix: `if (!enabled) {
    // prevRef.current.clear(); return; }` — pin the clear-on-disable
    // shape so a future "optimization" that drops the clear surfaces
    // here.
    expect(pageSrc).toMatch(/if\s*\(!enabled\)\s*{\s*prevRef\.current\.clear\(\);\s*return;/);
  });

  it("the enable-side branch still seeds the ref from current cohort HPs", () => {
    // The clear-on-disable would mask delta-sort entirely if the
    // enable-side write also got dropped — pin both halves.
    expect(pageSrc).toMatch(
      /for\s*\(const\s+t\s+of\s+cohort\)\s+prevRef\.current\.set\(t\.token\.toLowerCase\(\),\s*t\.hp\)/,
    );
  });
});
