/// Epic 1.19 regression — tile-grid responsive column-count.
///
/// jsdom doesn't run the layout engine, so CSS media queries don't apply
/// at the rendered-DOM level. We pin the constraint with source-greps
/// against globals.css — a future refactor that drops a breakpoint
/// surfaces here.
///
/// Spec §19.6.1 columns:
///   - ≥1024px: 3-col
///   - 700..1024px: 2-col
///   - <700px: tile view auto-disables → list fallback
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function readSource(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf-8");
}

describe("Epic 1.19 — tile grid responsive column-count", () => {
  const css = readSource("src/app/globals.css");

  it("≥1024px: `.ff-arena-tile-grid` declares `repeat(3, ...)` columns", () => {
    // The base rule (no media query) is the desktop case — pin the
    // 3-col shape on the bare class declaration.
    expect(css).toMatch(
      /\.ff-arena-tile-grid\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  it("700..1024px: a max-width:1024px media query sets `repeat(2, ...)` columns", () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1024px\)\s*{[^}]*\.ff-arena-tile-grid\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  it("<700px: the tile grid collapses to single column AND the toggle hides", () => {
    // Two co-located rules inside the same media block: the toggle hides
    // (so users can't switch INTO tile view from a phone) AND the grid
    // itself collapses to one column as a JS-fallback safety net.
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)\s*{[\s\S]*?\.ff-arena-view-toggle\s*{\s*display:\s*none/);
    expect(css).toMatch(
      /@media\s*\(max-width:\s*700px\)\s*{[\s\S]*?\.ff-arena-tile-grid\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it("declares a 16px gap on the tile grid (spec §19.6.1)", () => {
    // Gap is set inline by the grid wrapper — the 16 lives in the grid's
    // wrapper style. Pin it from the component source rather than CSS so
    // a refactor that moves the gap inline OR to CSS surfaces here.
    const componentSrc = readSource("src/components/arena/ArenaTileGrid.tsx");
    expect(componentSrc).toMatch(/gap:\s*16/);
  });
});
