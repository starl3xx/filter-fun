# Performance Audit (static red-flag scan)
**Audit Date:** 2026-05-01

---

## CRITICAL
None.

## HIGH

### [Performance] No CSP / next.config security or font-display headers
**Severity:** High
**Files:** packages/web/next.config.mjs
**Spec ref:** n/a

**Description:** Next config has only `redirects()`. No `headers()` to set CSP, X-Frame-Options, X-Content-Type-Options, font-display, etc.

**Recommendation:** Add `async headers()` with CSP, X-Frame-Options: DENY, X-Content-Type-Options: nosniff. Verify `font-display: swap` is applied (Next/font defaults — verify behaviour).

**Effort:** S

### [Performance] SSE lifecycle in `useTickerEvents` requires factoryRef stability
**Severity:** High → Medium
**Files:** packages/web/src/hooks/arena/useTickerEvents.ts:172
**Spec ref:** n/a

**Description:** Hook closes EventSource on unmount and tracks `mounted` correctly. Dependency array does not include `factoryRef`; if a parent recreates the factory each render, hook may misbehave. Mount/unmount cycles correctly free connections in code review.

**Recommendation:** Add a comment in the hook body: "Caller must not recreate factory on each render — wrap in useCallback or useMemo."

**Effort:** XS

---

## MEDIUM

### [Performance] Bundle includes full wagmi/chains
**Status:** ✅ **VERIFIED PASS** in `audit/polish-perf` (Polish 9 — Audit M-Perf-1). The audit's worry was a false alarm — the existing narrow named import (`import {base, baseSepolia} from "wagmi/chains"`) already tree-shakes correctly. Verification: ran `npx next build` and grepped the `.next/static/chunks/` output for chain-id markers. Result: exactly ONE chunk (`9872-…`, 44 KB) contains the base / baseSepolia chain ids; ZERO chunks contain other chain ids (Ethereum mainnet=1, Polygon=137, Optimism=10, BSC=56, Avalanche=43114 all absent). No code change needed; instead, a doc-anchor comment was added above the import in `packages/web/src/lib/wagmi.ts` documenting the verification result and warning future maintainers not to switch to `import * as` or to destructure into a const (both would defeat the tree-shake). Pinned by `polishPerfPass.test.tsx` (3 tests: literal-shape match, exactly-2-named-bindings check, no-namespace-import guard).

**Severity:** Medium
**Files:** packages/web/src/lib/wagmi.ts:1-2
**Spec ref:** n/a

**Description:** `import {base, baseSepolia} from "wagmi/chains"` may not tree-shake to a tiny subset; viem 2.x ships 900+ chain definitions.

**Recommendation:** Run `npm run build` and inspect chunk sizes. If chain-defs bundle is large, switch to viem chain-registry pattern.

**Effort:** M

### [Performance] React Query staleTime not explicitly set on per-page hooks
**Status:** ✅ **FIXED** in `audit/polish-perf` (Polish 9 — Audit M-Perf-2). All 4 token hooks (`useSeasonContext`, `useTokenAdmin`, `useStakeStatus`, `useCreatorFees`) now carry an explicit `staleTime` in every `useReadContract` query opt block, matching the existing `refetchInterval` value (15 s / 30 s / 60 s as appropriate). Default react-query staleTime is 0 — without the explicit value, every window-focus / mount / reconnect re-fetches even though the active poll just pulled the same data. Matching staleTime to refetchInterval makes focus events a no-op when the cache is fresh. Arena hooks (`hooks/arena/*`) intentionally keep the default 0 because real-time staleness is the contract there — pinned as a negative test in the regression bundle so a future "consistency pass" can't add staleTime to the arena hooks and break the live-feel contract on the leaderboard / tickers. Pinned by `polishPerfPass.test.tsx` (3 tests: every refetchInterval block has staleTime, sanity not-vacuous check, arena-boundary negative).

**Severity:** Medium → Low
**Files:** packages/web/src/hooks/token/*.ts
**Spec ref:** n/a

**Description:** Default staleTime 0 → refetch on every focus. Acceptable for live arena; over-aggressive for admin panels.

**Recommendation:** Set `staleTime: 30_000` on admin / claim hooks; keep 0 for arena.

**Effort:** S

### [Performance] No next/image — bare <img> for token avatars
**Status:** 🚧 **DEFER** in `audit/polish-perf` (Polish 9 — Audit M-Perf-3). Per POLISH_PLAN.md: deferred to Phase 2. Current "token avatars" are **inline SVG glyphs** (the 2-letter ticker tile rendered as a coloured div with grid-placed text — not raster images), so `next/image` doesn't apply to the present surface. The migration becomes meaningful once user-uploaded raster avatars / cover images land (Phase 2 metadata), at which point the `priority` + responsive-sizes story becomes load-bearing. Re-open this row when the metadata pipeline carries raster assets. No code change in this PR.

**Severity:** Medium
**Files:** packages/web/src (no next/image imports found)
**Spec ref:** n/a

**Description:** Misses Next.js responsive sizes / lazy load / blur placeholders.

**Recommendation:** Convert above-the-fold images to `next/image` with `priority`.

**Effort:** M

---

## LOW

### [Performance] ArenaLeaderboard rows not memoised
**Status:** 🚧 **DEFER** in `audit/polish-perf` (Polish 9 — Audit L-Perf-1). Per POLISH_PLAN.md: premature for the 12-row max cohort that the spec locks. React.memo + sort/filter memoisation is the right answer at scale, but at 12 rows the closure-allocation overhead of memo wrappers is a wash with the re-render cost they save — measurement-driven optimization deferred until the row count grows (which requires a spec change). Re-open this row if the cohort cap moves above ~50 rows. No code change in this PR.

**Severity:** Low
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx
**Spec ref:** n/a

**Description:** Full list re-renders on every HP update. Acceptable at 12 rows; would jank on lower-end devices if rows grew.

**Recommendation:** Wrap Row in `React.memo`; memoise sort/filter.

**Effort:** M

---

## INFO

### [Performance] "use client" directives correctly scoped to leaf components
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-perf` (Polish 9 — Audit I-Perf-1). Re-inspection confirms `app/page.tsx` and `app/layout.tsx` are still server components and only interactive leaves carry `"use client"`. SSR posture preserved. No code change.

**Severity:** Info
**Files:** packages/web/src/components/launch/LaunchForm.tsx:1, others
**Spec ref:** n/a

**Description:** Pages and layout remain server components; only interactive leaves opt in. Good SSR posture.

---

TOTAL: Critical=0 High=2 Medium=3 Low=1 Info=1
