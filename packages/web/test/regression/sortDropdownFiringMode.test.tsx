/// Epic 1.19 — bugbot finding regression (PR #91, commit d787b88).
///
/// `ArenaSortDropdown` only meaningfully controls the tile grid. The
/// home page's leaderboard branch falls back to `ArenaLeaderboard` when
/// `firingMode` is true (filter-moment firing/recap stage) regardless
/// of the user's view-mode preference. The dropdown's render gate must
/// mirror the same condition — pre-fix it only checked `effectiveViewMode
/// === "tile"`, leaving the dropdown stranded above the row layout
/// during firing/recap with tile mode selected.
///
/// Source-grep test (the dropdown's gate is one expression in `page.tsx`).
/// A future refactor that drops the `&& !firingMode` clause surfaces
/// here, not as a visual regression caught by a human.
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pageSrc = readFileSync(path.join(repoRoot, "src/app/page.tsx"), "utf-8");

describe("Epic 1.19 — sort dropdown gates on firingMode", () => {
  it("dropdown renders only when effectiveViewMode==='tile' AND !firingMode", () => {
    expect(pageSrc).toMatch(
      /effectiveViewMode\s*===\s*"tile"\s*&&\s*!firingMode\s*&&\s*\(\s*<ArenaSortDropdown/,
    );
  });

  it("the leaderboard branch shape that prompted the fix is preserved (`firingMode → row layout`)", () => {
    // The fix is only meaningful if the bottom branch still falls back
    // to the row layout under firingMode. Pin that path so a refactor
    // that drops the firingMode clause from the bottom branch (which
    // would make the dropdown gate's `!firingMode` clause vacuous and
    // mask a future regression) surfaces here too.
    expect(pageSrc).toMatch(/effectiveViewMode\s*===\s*"list"\s*\|\|\s*firingMode\s*\?[\s\S]*ArenaLeaderboard/);
  });
});
