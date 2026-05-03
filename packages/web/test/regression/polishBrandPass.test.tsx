/// PolishBrandPassTest — Audit polish pass (Phase 1, 2026-05-03)
///
/// Bundled regressions for the code-touching items in the brand polish PR.
/// Each test maps to one finding in audit/2026-05-PHASE-1-AUDIT/brand.md so
/// a future revert that drops the change surfaces with the audit ID in the
/// failure label.
///
/// Findings covered:
///   - M-Brand-1: zero inline `fontWeight: 900` sites remain in
///     packages/web/src — Bricolage Grotesque caps at 800 in the Google
///     distribution; pre-fix the browser silently substituted 800. This
///     test grep-pins the migration so the rendered weight matches the
///     code-truth weight everywhere.
///   - M-Brand-2: globals.css carries the doc block above
///     `@keyframes ff-pulse` enumerating which surfaces use the 2.4s
///     brand cadence vs the 1.2 / 1.4s urgency cadences — locks the
///     "split is the spec" rationale.
///   - M-Brand-3: Brand component in ArenaTopBar.tsx carries the doc
///     block explaining text composition is canonical and the SVG assets
///     are export-only — locks against a future "let's just use the SVG"
///     refactor.
///   - L-Brand-2: LaunchHero.tsx carries the doc block above the hero
///     gradient documenting the deliberate divergence from the mark
///     gradient (different surface → different angle + extended palette).
///
/// These are source-grep tests rather than render assertions because the
/// changes are doc + style migrations that don't surface as DOM behaviour
/// and the components have heavy wagmi / chain dependencies that aren't
/// worth scaffolding for a comment check.
import * as fs from "node:fs";
import * as path from "node:path";

import {describe, expect, it} from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../../src");

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
}

function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSrc(full));
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// M-Brand-1 ----------------------------------------------------------------
//
// Pre-fix: 14 inline `fontWeight: 900` sites across 9 files (LaunchForm,
// LaunchHero, SlotGrid×2, BagLockCard, ArenaTicker, ArenaTokenDetail,
// FilterEventReveal, ArenaLeaderboard×4, RecapCard×2) requested a Black
// weight that next/font's Google distribution of Bricolage Grotesque does
// NOT publish — the available weights are 200/300/400/500/600/700/800.
// The browser silently substituted 800. Post-fix every site is migrated
// to `fontWeight: 800` so code-truth matches rendered-truth.
describe("M-Brand-1: no inline `fontWeight: 900` remains in packages/web/src", () => {
  it("zero source files contain a `fontWeight: 900` style declaration", () => {
    const files = walkSrc(SRC_ROOT);
    const offenders: string[] = [];
    // Match `fontWeight: 900` and the quoted variants `"900"` / `'900'`,
    // ignoring whitespace around the colon. Doc-comment mentions of the
    // string `fontWeight: 900` (e.g., the layout.tsx audit anchor) are
    // excluded by checking the line is not inside a JS line/block comment
    // — the simplest way is to scan lines that don't start with `//` /
    // ` *` after trim. Style declarations always appear inside JSX style
    // objects so the line either starts with whitespace then a key, or
    // sits inline in a template — neither starts with `//` or `*`.
    const re = /\bfontWeight\s*:\s*(?:900|["']900["'])\b/;
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("///")) continue;
        if (re.test(line)) {
          offenders.push(`${path.relative(SRC_ROOT, f)}:${i + 1}: ${trimmed}`);
        }
      }
    }
    expect(offenders, `inline fontWeight: 900 found (Bricolage Grotesque caps at 800 — migrate to 800):\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("layout.tsx still imports the 5 spec-mandated Bricolage weights (400/500/600/700/800) and no others", () => {
    const layout = readSrc("app/layout.tsx");
    // The Bricolage_Grotesque({...weight: [...]}) array must be exactly
    // these 5 weights — adding `"900"` would break the build, removing
    // any of `"500"` / `"600"` would regress the Arena audit fix.
    const m = layout.match(/Bricolage_Grotesque\(\{[\s\S]*?weight:\s*\[([^\]]+)\][\s\S]*?\}\)/);
    expect(m).not.toBeNull();
    const weights = (m?.[1] ?? "")
      .split(",")
      .map((s) => s.replace(/["'\s]/g, ""))
      .filter(Boolean);
    expect(weights.sort()).toEqual(["400", "500", "600", "700", "800"]);
  });
});

// M-Brand-2 ----------------------------------------------------------------
//
// Pre-fix: globals.css had 4 different pulse cadences (1.2s, 1.4s×2,
// 2.4s×2) with no doc explaining the split. The brand kit locks the
// literal ▼ MARK glyph at 2.4s; the faster cadences are intentional UX
// (urgency). Post-fix: doc block above `@keyframes ff-pulse` enumerates
// which surface uses which cadence and why.
describe("M-Brand-2: globals.css doc block enumerates the pulse cadence split", () => {
  it("the doc block above @keyframes ff-pulse mentions all 4 cadences + the split rationale", () => {
    const css = readSrc("app/globals.css");
    // Pull the comment block immediately preceding the `@keyframes ff-pulse`
    // declaration. The block is bounded by `/*` and `*/`.
    const idx = css.indexOf("@keyframes ff-pulse");
    expect(idx).toBeGreaterThan(0);
    const before = css.slice(0, idx);
    const lastOpen = before.lastIndexOf("/*");
    const lastClose = before.lastIndexOf("*/");
    expect(lastOpen).toBeGreaterThan(0);
    expect(lastClose).toBeGreaterThan(lastOpen);
    const block = before.slice(lastOpen, lastClose + 2);
    // The block must namespace itself to M-Brand-2 so the audit anchor
    // surfaces in any future grep / failure trace.
    expect(block).toMatch(/M-Brand-2/);
    // And it must enumerate the cadences so a future maintainer can see
    // the split is intentional, not accidental.
    expect(block).toMatch(/2\.4s/);
    expect(block).toMatch(/1\.4s/);
    expect(block).toMatch(/1\.2s/);
    // The "identity vs urgency" rationale is the load-bearing part —
    // pin it so a future "tighten the doc block" pass can't drop it.
    expect(block.toLowerCase()).toMatch(/identity/);
    expect(block.toLowerCase()).toMatch(/urgency/);
  });
});

// M-Brand-3 ----------------------------------------------------------------
//
// Pre-fix: the Brand component in ArenaTopBar renders text composition
// for `filter` + `.fun` but never explains why the brand-kit SVG assets
// are not used. The audit's recommendation (b) was chosen — text
// composition is canonical for in-app surfaces, SVG is export-only.
// Post-fix: doc block inside the Brand component carries the rationale.
describe("M-Brand-3: ArenaTopBar Brand component documents text-vs-SVG choice", () => {
  it("the Brand component carries the M-Brand-3 doc block", () => {
    const topBar = readSrc("components/arena/ArenaTopBar.tsx");
    // The component definition lives at `function Brand()`. Pull the
    // comment slab inside the function body.
    const fnIdx = topBar.indexOf("function Brand()");
    expect(fnIdx).toBeGreaterThan(0);
    // Look forward 1500 chars (covers the comment slab + opening JSX)
    // for the audit anchor and the load-bearing claims.
    const slab = topBar.slice(fnIdx, fnIdx + 1500);
    expect(slab).toMatch(/M-Brand-3/);
    expect(slab.toLowerCase()).toMatch(/canonical/);
    expect(slab.toLowerCase()).toMatch(/export-only|export only/);
    // Mention of the SVG asset names so a future maintainer searching
    // for `wordmark.svg` lands on the rationale.
    expect(slab).toMatch(/wordmark\.svg/);
  });
});

// L-Brand-2 ----------------------------------------------------------------
//
// Pre-fix: the LaunchHero gradient `linear-gradient(90deg, #ff5fb8,
// #ff2d55, #ffe933)` differs from the mark gradient (180deg pink→red
// without yellow). This is intentional — different surface, different
// gradient — but was undocumented. Post-fix: comment block above the
// gradient definition explains the deliberate divergence.
describe("L-Brand-2: LaunchHero gradient carries the intentional-divergence doc block", () => {
  it("the comment block above the hero gradient mentions the audit anchor + rationale", () => {
    const hero = readSrc("components/launch/LaunchHero.tsx");
    // The gradient line is unique enough to anchor on directly.
    const gradIdx = hero.indexOf("linear-gradient(90deg, #ff5fb8, #ff2d55, #ffe933)");
    expect(gradIdx).toBeGreaterThan(0);
    // Look back 1500 chars for the comment slab.
    const before = hero.slice(Math.max(0, gradIdx - 1500), gradIdx);
    expect(before).toMatch(/L-Brand-2/);
    // The "different surface" claim is the load-bearing part of the
    // rationale; pin it. Collapse whitespace first so the line-wrapped
    // comment ("is a different\n              surface than") still
    // matches.
    const flat = before.toLowerCase().replace(/\s+/g, " ");
    expect(flat).toMatch(/different surface/);
    // And the "yellow" stop is the spec-divergent piece, so the doc
    // must mention it.
    expect(flat).toMatch(/yellow/);
  });
});
