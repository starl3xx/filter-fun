/// Epic 1.19 regression — mobile force-fallback to list view.
///
/// At <700px the spec disables the tile view: a phone screen can't fit a
/// 2/3-col grid, and a one-column degenerate tile is visually identical
/// to the row layout while costing more DOM nodes. The page enforces
/// this with a JS gate (`useIsNarrow` matchMedia listener) AND a CSS
/// rule (the toggle button hides via `@media (max-width: 700px)`).
///
/// We can't run the page through a real layout engine in jsdom, so we
/// pin the constraint with a two-channel test:
///   1. Source-grep the page for the `effectiveViewMode = isNarrow ? "list"
///      : viewMode` gate so a future refactor that drops it surfaces here.
///   2. Source-grep globals.css for the `.ff-arena-view-toggle { display:
///      none }` mobile rule so the visual half of the constraint stays.
///
/// A future Playwright suite can verify the rendered behaviour on a real
/// 380px viewport; until then these greps are the regression anchor.
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
function readSource(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf-8");
}

describe("Epic 1.19 — mobile force-fallback to list view", () => {
  it("page.tsx routes through `effectiveViewMode = isNarrow ? \"list\" : viewMode`", () => {
    const src = readSource("src/app/page.tsx");
    expect(src).toMatch(/effectiveViewMode\s*=\s*isNarrow\s*\?\s*"list"\s*:\s*viewMode/);
  });

  it("page.tsx defines a `useIsNarrow` hook backed by matchMedia(700px)", () => {
    const src = readSource("src/app/page.tsx");
    expect(src).toMatch(/function useIsNarrow\(/);
    expect(src).toMatch(/matchMedia\("\(max-width:\s*700px\)"\)/);
  });

  it("globals.css hides the view-toggle below 700px", () => {
    const css = readSource("src/app/globals.css");
    // The `.ff-arena-view-toggle { display: none !important; }` rule must
    // sit inside a `@media (max-width: 700px)` block. Match the structure
    // rather than a flat substring so an accidental move out of the
    // media query (which would hide the toggle on desktop) trips here.
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)\s*{[^}]*\.ff-arena-view-toggle\s*{\s*display:\s*none/);
  });

  it("page.tsx falls back to ArenaLeaderboard (not ArenaTileGrid) when effectiveViewMode === 'list'", () => {
    const src = readSource("src/app/page.tsx");
    // The branch shape is `effectiveViewMode === "list" || firingMode ?
    // <ArenaLeaderboard ... /> : <ArenaTileGrid ... />`. Pin the discriminator
    // and the leaderboard branch.
    expect(src).toMatch(/effectiveViewMode\s*===\s*"list"\s*\|\|\s*firingMode\s*\?[\s\S]*ArenaLeaderboard/);
  });
});
