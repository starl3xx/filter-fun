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
**Severity:** Medium
**Files:** packages/web/src/lib/wagmi.ts:1-2
**Spec ref:** n/a

**Description:** `import {base, baseSepolia} from "wagmi/chains"` may not tree-shake to a tiny subset; viem 2.x ships 900+ chain definitions.

**Recommendation:** Run `npm run build` and inspect chunk sizes. If chain-defs bundle is large, switch to viem chain-registry pattern.

**Effort:** M

### [Performance] React Query staleTime not explicitly set on per-page hooks
**Severity:** Medium → Low
**Files:** packages/web/src/hooks/token/*.ts
**Spec ref:** n/a

**Description:** Default staleTime 0 → refetch on every focus. Acceptable for live arena; over-aggressive for admin panels.

**Recommendation:** Set `staleTime: 30_000` on admin / claim hooks; keep 0 for arena.

**Effort:** S

### [Performance] No next/image — bare <img> for token avatars
**Severity:** Medium
**Files:** packages/web/src (no next/image imports found)
**Spec ref:** n/a

**Description:** Misses Next.js responsive sizes / lazy load / blur placeholders.

**Recommendation:** Convert above-the-fold images to `next/image` with `priority`.

**Effort:** M

---

## LOW

### [Performance] ArenaLeaderboard rows not memoised
**Severity:** Low
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx
**Spec ref:** n/a

**Description:** Full list re-renders on every HP update. Acceptable at 12 rows; would jank on lower-end devices if rows grew.

**Recommendation:** Wrap Row in `React.memo`; memoise sort/filter.

**Effort:** M

---

## INFO

### [Performance] "use client" directives correctly scoped to leaf components
**Severity:** Info
**Files:** packages/web/src/components/launch/LaunchForm.tsx:1, others
**Spec ref:** n/a

**Description:** Pages and layout remain server components; only interactive leaves opt in. Good SSR posture.

---

TOTAL: Critical=0 High=2 Medium=3 Low=1 Info=1
