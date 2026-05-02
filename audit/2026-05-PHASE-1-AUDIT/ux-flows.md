# UX Flows Audit (7 flows)
**Audit Date:** 2026-05-01

---

## Flow 1 — First-time visitor (no wallet)

### [UX] No prominent wallet-connect CTA on the homepage
**Severity:** Medium
**Files:** packages/web/src/app/page.tsx, packages/web/src/components/broadcast/TopBar.tsx
**Spec ref:** n/a

**Description:** Visitor lands on `/`, sees the leaderboard, and must click into a token detail to be prompted for a wallet. There is no top-bar Connect button visible from the page review (broadcast/TopBar appears not to host one). This works for a passive observer but adds friction for a first-time trader.

**Recommendation:** Add a Connect button to the top bar that opens the wagmi connector picker.

**Effort:** S

---

## Flow 2 — Connected trader (browse → click token → simulated buy)

### [UX] No actual trade panel found on /
**Severity:** High → Medium (depending on Phase 1 scope)
**Files:** packages/web/src/components/arena/ArenaTokenDetail.tsx
**Spec ref:** ARENA_SPEC §6.5

**Description:** ArenaTokenDetail renders stats, HP breakdown, status, lock info — but no BUY/SELL panel was located in code. ARENA_SPEC §6.5 calls for BUY (green→cyan) and SELL (red→pink) CTAs. Either the trade panel is wired elsewhere (e.g., external Uniswap link) or it is deferred to Phase 2.

**Recommendation:** Confirm scope. If deferred, add explicit "Trade on Uniswap" external CTA. If in-app, build the panel per §6.5.

**Effort:** L

### [UX] Token selection state is local; not persisted across page refresh
**Severity:** Low
**Files:** packages/web/src/app/page.tsx
**Spec ref:** ARENA_SPEC §11

**Description:** Selecting a token does not write to the URL (e.g., `?token=0x…`). On refresh, selection resets to rank-1.

**Recommendation:** Sync selection to a `?token=` query param (component already accepts it as initial state).

**Effort:** S

---

## Flow 3 — Creator launching a token (/launch)

### [UX] Cost panel has no "loading…" state if status read is slow
**Severity:** Medium
**Files:** packages/web/src/app/launch/page.tsx (CostPanel uses `status?.nextLaunchCostWei`)
**Spec ref:** n/a

**Recommendation:** Render a skeleton/dashes while `status` is undefined.

**Effort:** XS

### [UX] Eligibility-blocked state — copy not verified
**Severity:** Medium
**Files:** packages/web/src/app/launch/page.tsx:198-203
**Spec ref:** §4.6

**Description:** When `eligibility.state` is not `eligible`, NoticeCard is rendered with `titleFor()` + `eligibility.message`. The copy variants for "launch window closed", "wallet not eligible", "max launches reached" are not all visible in the audit slice; verify each variant is helpful and actionable (i.e., tells the user what to do next).

**Recommendation:** Walk all `eligibility.state` enum branches; ensure each has a clear next-step message.

**Effort:** S

### [UX] Cost lives in a ref — live cost may differ from cost shown at submit
**Severity:** Medium (covered in web-general High finding)
**Files:** packages/web/src/app/launch/page.tsx:100-101,125
**Spec ref:** n/a

**Recommendation:** See web-general.md High finding: lock-at-submit OR document live-read intent.

**Effort:** S

---

## Flow 4 — Creator managing token (/token/[address]/admin)

### [UX] Loading state during admin-data fetch not surfaced
**Severity:** Medium
**Files:** packages/web/src/app/token/[address]/admin/page.tsx (admin sub-components)
**Spec ref:** §38

**Description:** `useTokenAdmin` exposes `isLoading: adminLoading`. The page reads it (line 64) but the loading branch is not visible in the audit slice. If the page renders with stale/null `info` while loading, the user sees an empty layout.

**Recommendation:** Show skeleton cards in the centre column while loading; only render forms after `info` resolves.

**Effort:** S

### [UX] Tx pending / success states not verified across admin sub-forms
**Severity:** Medium
**Files:** packages/web/src/components/admin/{ClaimFeesPanel.tsx, MetadataForm.tsx, AdminTransferForms.tsx, BagLockCard.tsx}
**Spec ref:** §38

**Description:** Each form should show "Pending…", "Confirming…", and a success state after a transaction mines. Pattern review is needed across all four.

**Recommendation:** Walk each form, ensure tx state visualized consistently with the BUY/SELL pattern from launch.

**Effort:** M

---

## Flow 5 — Holder claiming rollover (/claim/rollover)

### [UX] Merkle proof failure surfaced as raw tx error
**Severity:** Medium
**Files:** packages/web/src/components/ClaimForm.tsx (submitError)
**Spec ref:** §22

**Description:** A bad proof reverts on-chain. The error bubbles up from `useWriteContract` and renders verbatim. User sees something like "execution reverted (0x…)" with no hint that the proof was invalid.

**Recommendation:** Map known revert selectors to friendly messages (`InvalidProof()` → "This claim is not valid for your wallet — verify you pasted the correct proof.").

**Effort:** S

### [UX] No "I lost my claim, send it again" recovery path
**Severity:** Low
**Files:** packages/web/src/app/claim/rollover/page.tsx
**Spec ref:** §22

**Description:** If user pasted invalid JSON or lost their claim email/copy, there is no link to a help page or a re-issue flow.

**Recommendation:** Add a small "Need your claim again?" link that points to docs or support.

**Effort:** XS

---

## Flow 6 — Holder claiming hold bonus (/claim/bonus)

### [UX] No distinction between "not yet claimed" and "ineligible"
**Severity:** Medium
**Files:** packages/web/src/components/ClaimForm.tsx (StatusBadge)
**Spec ref:** §22

**Description:** StatusBadge shows "checking…" / "claimed" / "unknown". Ineligible (failed 14-day hold check) presents identically to "not yet claimed". User attempts to claim, contract reverts.

**Recommendation:** Pre-flight call to a read function (e.g., `eligibilityFor(address)`) to surface ineligibility before signing.

**Effort:** M

### [UX] Time-window gating not visible in client code
**Severity:** Low → Info
**Files:** packages/web/src/app/claim/bonus/page.tsx
**Spec ref:** §22

**Description:** Spec implies the 14-day hold window gates eligibility; the client doesn't display the gate (e.g., "Bonus opens 2026-05-14"). May be enforced fully on-chain via Merkle root publication time.

**Recommendation:** Surface the bonus window in the page header even if the contract enforces it.

**Effort:** S

---

## Flow 7 — Filter moment spectator

### [UX] Slow-network FILTER_FIRED arrival edge case not handled
**Severity:** Low
**Files:** packages/web/src/components/arena/filterMoment/FilterMomentOverlay.tsx
**Spec ref:** §21

**Description:** Reveal animation triggers on FILTER_FIRED event arrival. If the SSE reconnects mid-event or arrives >10 s late, the reveal could fire after the locked window passes, leaving a stale overlay or skipping the recap.

**Recommendation:** Add a fallback: if the event hasn't arrived within `FILTER_MOMENT_WINDOW_MS` of the scheduled cut, render a degraded "Filter just fired — refreshing leaderboard" state and re-fetch /tokens.

**Effort:** M

### [UX] No survivor-count guard
**Severity:** Low
**Files:** packages/web/src/components/arena/filterMoment/FilterEventReveal.tsx
**Spec ref:** §21

**Description:** Component accepts `survivors` and `filtered` numeric props with no lower bound. If a misconfigured cohort yields 0 survivors, the UI renders "0 SURVIVED" — semantically valid but visually off.

**Recommendation:** Validate `survivors >= 1`; render a fallback if 0.

**Effort:** XS

---

TOTAL: Critical=0 High=0-1 Medium=8 Low=4 Info=0
