# Brand Kit Adherence Audit
**Audit Date:** 2026-05-01
**Reference:** /Users/jakebouma/Documents/Claude/Projects/filter.fun/filter.fun-brand-kit/

---

## CRITICAL
None.

## HIGH
None.

## MEDIUM

### [Brand] Bricolage Grotesque weight 900 used but not loaded
**Severity:** Medium
**Files:** packages/web/src/app/layout.tsx:8-13, 15+ inline `fontWeight: 900` sites across components
**Spec ref:** brand-kit + ARENA_SPEC §2.1

**Description:**
The next/font import declares weights `["400", "700", "800"]`. Components frequently set `fontWeight: 900` (e.g., headlines, wordmark). The browser silently falls back to the closest loaded weight (800), which subtly shifts hierarchy.

**Evidence:** `grep -rn 'fontWeight: 900' packages/web/src/components` returns 15+ sites.

**Recommendation:** Add `"900"` to the weight array (and `"500"`, `"600"` per Arena audit).

**Effort:** XS

### [Brand] Multiple pulse cadences in use; brand spec locks 2.4s for the mark
**Severity:** Medium
**Files:** packages/web/src/app/globals.css (`ff-pulse` 1.4s, `ff-arena-cutline-urgent` 1.2s, `ff-filter-moment-clock-pulse` 2.4s, `ff-filter-moment-rollover-pulse` 2.4s)
**Spec ref:** brand-kit lock — ▼ pulses at 2.4s

**Description:**
Brand kit specifies the mark pulses at 2.4s ease-in-out. Code has at least three different pulse cadences. The intent is unclear: is the 2.4s applied only to the mark, or to all pulse-style highlights? The fast 1.2s/1.4s pulses on at-risk chips and ticker strips conflict with the locked cadence if interpreted broadly.

**Recommendation:** Either (a) document that only the literal mark-glyph elements use the locked 2.4s and other pulses are intentionally faster for urgency UX, or (b) consolidate to a single locked cadence. Recommend (a) — fast pulses on AT_RISK convey urgency; slower pulse for brand identity is correct on the mark.

**Effort:** XS (documentation) or M (consolidation)

### [Brand] No React wordmark component; SVG asset exists in brand kit but is not integrated
**Severity:** Medium
**Files:** packages/web/src/components/ (no wordmark component) vs filter.fun-brand-kit/wordmark.svg
**Spec ref:** brand-kit / ARENA_SPEC §6.1

**Description:**
ArenaTopBar `Brand` component renders text "filter.fun" (and currently in single colour — see Arena audit High finding for `.fun` pink split). The brand kit ships `wordmark.svg` and `lockup-tagline.svg` that are not used anywhere. Either the spec intends the SVG asset be embedded for crisper rendering at small sizes, or the text composition is the canonical method.

**Recommendation:** Either (a) add a `<Wordmark>` React component that renders the SVG and use it in ArenaTopBar, or (b) document that text composition is canonical and the SVG is an export-only artifact for off-app use (social, press kit).

**Effort:** S (component) or XS (doc)

---

## LOW

### [Brand] Unused CSS var `--ff-grad-mark`
**Severity:** Low
**Files:** packages/web/src/app/globals.css:27
**Spec ref:** n/a

**Description:** `--ff-grad-mark: linear-gradient(180deg, #ff5fb8, #ff2d55)` is defined but not referenced anywhere. Triangle.tsx hardcodes the same gradient inline.

**Recommendation:** Either delete (Triangle component is canonical) or refactor Triangle to read the CSS var.

**Effort:** XS

### [Brand] LaunchHero gradient direction differs from mark gradient
**Severity:** Low → Info
**Files:** packages/web/src/components/launch/LaunchHero.tsx:78
**Spec ref:** brand-kit

**Description:** Hero uses `linear-gradient(90deg, #ff5fb8, #ff2d55, #ffe933)` (90deg, plus yellow). Mark gradient is 180deg pink→red. This is reasonable as a *hero* gradient (different surface) but worth documenting if intentional.

**Recommendation:** Treat as intentional. Add a comment that it deliberately extends the mark gradient with yellow on the hero surface.

**Effort:** XS (comment only)

---

## INFO

### [Brand] Color palette matches brand-kit/palette.json exactly (10 named colors)
**Severity:** Info — PASS
**Files:** packages/web/src/lib/tokens.ts, packages/web/src/app/globals.css

All 10 named colors (pink #ff3aa1, pinkLight #ff5fb8, red #ff2d55, cyan #00f0ff, yellow #ffe933, green #52ff8b, purple #9c5cff, ink #1a012a, cream #fef2ff, bg #0a0612, bg2 #140828) match palette.json.

### [Brand] Locked tagline used verbatim across all surfaces
**Severity:** Info — PASS
**Files:** README.md, packages/web/README.md, packages/web/src/app/layout.tsx (3×)

`"Get filtered or get funded ▼"` — no variants found.

---

TOTAL: Critical=0 High=0 Medium=3 Low=2 Info=2
