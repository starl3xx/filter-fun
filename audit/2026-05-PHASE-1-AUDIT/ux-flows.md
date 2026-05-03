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

**Status (M-Ux-1, 2026-05-03):** ✅ FIXED. ArenaTopBar (`packages/web/src/components/arena/ArenaTopBar.tsx:108`) now hosts an inline `ConnectWalletButton` at the right edge of the bar. It picks the injected connector, renders a pink→purple gradient "Connect Wallet" CTA when disconnected, and the short `0x6…4` address (click-to-disconnect) when connected. Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-1, 2 cases — disconnected + connected).

---

## Flow 2 — Connected trader (browse → click token → simulated buy)

### [UX] No actual trade panel found on /
**Severity:** High → Medium (depending on Phase 1 scope)
**Files:** packages/web/src/components/arena/ArenaTokenDetail.tsx
**Spec ref:** ARENA_SPEC §6.5

**Description:** ArenaTokenDetail renders stats, HP breakdown, status, lock info — but no BUY/SELL panel was located in code. ARENA_SPEC §6.5 calls for BUY (green→cyan) and SELL (red→pink) CTAs. Either the trade panel is wired elsewhere (e.g., external Uniswap link) or it is deferred to Phase 2.

**Recommendation:** Confirm scope. If deferred, add explicit "Trade on Uniswap" external CTA. If in-app, build the panel per §6.5.

**Effort:** L

**Status (H-Ux-1, 2026-05-03):** 🚧 DEFER (Phase 2). The in-app trade panel is explicitly Phase 2 scope — Genesis ships with the ArenaTokenDetail readout + external Uniswap routing handled at the contract layer. Adding an inline "Trade on Uniswap" external CTA without a verified V4 pool URL would shipping a dead link, so the recommendation is parked until the V4 hook + pool address pipeline lands. Tracked as a Phase 2 backlog item.

### [UX] Token selection state is local; not persisted across page refresh
**Severity:** Low
**Files:** packages/web/src/app/page.tsx
**Spec ref:** ARENA_SPEC §11

**Description:** Selecting a token does not write to the URL (e.g., `?token=0x…`). On refresh, selection resets to rank-1.

**Recommendation:** Sync selection to a `?token=` query param (component already accepts it as initial state).

**Effort:** S

**Status (M-Ux-3, 2026-05-03):** ✅ FIXED. `app/page.tsx` now syncs `selected` → `?token=` via a `useEffect` that calls `window.history.replaceState` (not `pushState`, so the back button doesn't replay every selection click). Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-3 — source-grep test asserts both the replaceState call and the absence of pushState; the page is too heavy to mount under jsdom without mocking the entire wagmi + indexer surface).

---

## Flow 3 — Creator launching a token (/launch)

### [UX] Cost panel has no "loading…" state if status read is slow
**Severity:** Medium
**Files:** packages/web/src/app/launch/page.tsx (CostPanel uses `status?.nextLaunchCostWei`)
**Spec ref:** n/a

**Recommendation:** Render a skeleton/dashes while `status` is undefined.

**Effort:** XS

**Status (M-Ux-4, 2026-05-03):** ✅ FIXED. `CostPanel` accepts a `costLoading?: boolean` prop and renders "—" in the ETH/USD value cells when true (instead of the misleading "Ξ 0.0000" / "$0" the pre-fix code rendered while reading the launcher contract). The launch page passes `costLoading={status === undefined || !stakeReady}`, so first paint shows dashes until both the cost and stake reads resolve. The stake row continues to render during load to avoid a layout shift. Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-4 — 3 cases: dashes when loading, real values when not, and the launch-page wiring).

### [UX] Eligibility-blocked state — copy not verified
**Severity:** Medium
**Files:** packages/web/src/app/launch/page.tsx:198-203
**Spec ref:** §4.6

**Description:** When `eligibility.state` is not `eligible`, NoticeCard is rendered with `titleFor()` + `eligibility.message`. The copy variants for "launch window closed", "wallet not eligible", "max launches reached" are not all visible in the audit slice; verify each variant is helpful and actionable (i.e., tells the user what to do next).

**Recommendation:** Walk all `eligibility.state` enum branches; ensure each has a clear next-step message.

**Effort:** S

**Status (M-Ux-5, 2026-05-03):** ✅ FIXED. All five `useEligibility` branches (`not-connected`, `loading`, `wrong-chain`, `already-launched`, `window-closed`) now carry actionable messages ≥60 chars that name the next step. Examples: `not-connected` → "Use the Connect Wallet button in the top bar to choose a wallet — once connected, the launch form unlocks here."; `already-launched` → "You've already launched a token this week — each wallet gets one shot per season. The next launch window opens Monday 00:00 UTC; come back then to launch again." Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-5 — asserts ≥5 messages, each ≥60 chars and matching an actionable verb cue).

### [UX] Cost lives in a ref — live cost may differ from cost shown at submit
**Severity:** Medium (covered in web-general High finding)
**Files:** packages/web/src/app/launch/page.tsx:100-101,125
**Spec ref:** n/a

**Recommendation:** See web-general.md High finding: lock-at-submit OR document live-read intent.

**Effort:** S

**Status (M-Ux-6, 2026-05-03):** ↩ CLOSE-INCIDENTAL. This is a duplicate of `web-general.md` H-Web-2 (cost-lock-at-submit) which was addressed in Polish 3 — `useLatestRef` was renamed and its live-read intent documented inline at `app/launch/page.tsx`. No new code change required from this PR; cross-reference updated.

---

## Flow 4 — Creator managing token (/token/[address]/admin)

### [UX] Loading state during admin-data fetch not surfaced
**Severity:** Medium
**Files:** packages/web/src/app/token/[address]/admin/page.tsx (admin sub-components)
**Spec ref:** §38

**Description:** `useTokenAdmin` exposes `isLoading: adminLoading`. The page reads it (line 64) but the loading branch is not visible in the audit slice. If the page renders with stale/null `info` while loading, the user sees an empty layout.

**Recommendation:** Show skeleton cards in the centre column while loading; only render forms after `info` resolves.

**Effort:** S

**Status (M-Ux-7, 2026-05-03):** ✅ FIXED. The admin page now destructures `isLoading: statsLoading` from `useTokenStats` and renders a `<SkeletonStack>` (4 pulsing cards) while `tokenStats === null && statsLoading`. This is distinguished from the not-in-cohort case (token exists on chain but isn't in the active season's cohort), which still renders the existing "not in current cohort" notice. Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-7 — asserts the destructured `statsLoading`, the SkeletonStack render branch, and the helper definition).

### [UX] Tx pending / success states not verified across admin sub-forms
**Severity:** Medium
**Files:** packages/web/src/components/admin/{ClaimFeesPanel.tsx, MetadataForm.tsx, AdminTransferForms.tsx, BagLockCard.tsx}
**Spec ref:** §38

**Description:** Each form should show "Pending…", "Confirming…", and a success state after a transaction mines. Pattern review is needed across all four.

**Recommendation:** Walk each form, ensure tx state visualized consistently with the BUY/SELL pattern from launch.

**Effort:** M

**Status (M-Ux-8, 2026-05-03):** ✅ FIXED. All four admin sub-forms (`ClaimFeesPanel`, `MetadataForm`, `AdminTransferForms`, `BagLockCard`) now use the canonical 3-state pattern: idle → "Sign in wallet…" (wallet prompt pending) → "Confirming…" (tx broadcast, awaiting mine) → idle. The pre-fix state was inconsistent — three forms used "Submitting…" (which conflated "wallet prompt up" with "tx broadcast") and BagLockCard used the wordier "Confirming on-chain…". Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-8 — one source-grep test per file asserting both copy strings exist and the legacy "Submitting…" copy is gone).

---

## Flow 5 — Holder claiming rollover (/claim/rollover)

### [UX] Merkle proof failure surfaced as raw tx error
**Severity:** Medium
**Files:** packages/web/src/components/ClaimForm.tsx (submitError)
**Spec ref:** §22

**Description:** A bad proof reverts on-chain. The error bubbles up from `useWriteContract` and renders verbatim. User sees something like "execution reverted (0x…)" with no hint that the proof was invalid.

**Recommendation:** Map known revert selectors to friendly messages (`InvalidProof()` → "This claim is not valid for your wallet — verify you pasted the correct proof.").

**Effort:** S

**Status (M-Ux-9, 2026-05-03):** ✅ FIXED. `ClaimForm.tsx` now exports a `humanizeClaimError(raw)` helper that maps known revert names + 4-byte selectors to friendly copy. Selectors verified via `viem.toFunctionSelector`: `InvalidProof()` → `0x09bde339`, `AlreadyClaimed()` → `0x646cf558`, `WrongPhase()` → `0xe2586bcc`, `BonusLocked()` → `0xf1192f69`, `AlreadySettled()` → `0x560ff900`, `AlreadyFunded()` → `0x5adf6387`, `ClaimExceedsAllocation()` → `0x12f02dca`. User-rejected wallet errors get a friendly retry message; unknown reverts fall back to "Claim failed." + the truncated raw text (capped at 240 chars + ellipsis to avoid pasting a viem stack trace into the UI). Wired in via `<ErrorRow>{humanizeClaimError(submitError.message)}</ErrorRow>`. Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-9 — 10 behaviour tests on the helper directly: each known mapping, user-rejected, unknown, null/undefined, and the 240-char truncation).

**Bugbot follow-up (PR #81 round 1, 2026-05-03):** Pre-fix the helper mapped the "settlement hasn't completed yet" copy to `AlreadySettled()`, but bugbot caught that this error is unreachable from user claim paths — TournamentVault's `claim*` functions revert with `WrongPhase()` (line 354/378/494/512) when called before `t.phase == Settled`, while `AlreadySettled()` only fires from the oracle-only `settle*` functions. Re-anchored the user-facing settlement-timing copy to `WrongPhase()`, demoted `AlreadySettled()` to a separate admin-flavoured message ("This season has already been settled…"), and added `BonusLocked()` mapping for the parallel time-window guard on `claimQuarterlyBonus`/`claimAnnualBonus`. Anti-pin: regression test asserts `AlreadySettled()` does NOT carry the "hasn't completed yet" copy, so a re-conflation of the two errors fails the suite.

### [UX] No "I lost my claim, send it again" recovery path
**Severity:** Low
**Files:** packages/web/src/app/claim/rollover/page.tsx
**Spec ref:** §22

**Description:** If user pasted invalid JSON or lost their claim email/copy, there is no link to a help page or a re-issue flow.

**Recommendation:** Add a small "Need your claim again?" link that points to docs or support.

**Effort:** XS

**Status (M-Ux-10, 2026-05-03):** ✅ FIXED. `app/claim/rollover/page.tsx` now renders a `<ClaimRecoveryFooter>` below the claim form linking to `https://docs.filter.fun/claims/recovery` (target="_blank" rel="noopener noreferrer"). Copy: "Need your claim JSON again? Follow the recovery flow." Pinned by `polishUxFlowsPass.test.tsx` (M-Ux-10 — asserts the copy, the docs URL, and the security-sensitive `target` + `rel` attributes).

**Bugbot follow-up (PR #81 round 2, 2026-05-03):** Pre-fix the footer rendered as a fragment sibling of `<ClaimForm/>`, which placed it OUTSIDE the constrained `<main>` (globals.css applies `max-width: 720px; margin: 0 auto` to `main:not(.ff-arena-grid):not(.ff-launch-page)`). Result: footer spanned the full viewport while the form above was capped at 720px and centered. Fixed by adding `headerSlot?: ReactNode` and `footerSlot?: ReactNode` props to ClaimForm and routing both `<BonusWindowCard>` and `<ClaimRecoveryFooter>` through the slots so they render INSIDE the `<main>` and inherit the constraint. Anti-pin tests assert each helper is wired via the slot prop AND is NOT rendered as a fragment sibling.

---

## Flow 6 — Holder claiming hold bonus (/claim/bonus)

### [UX] No distinction between "not yet claimed" and "ineligible"
**Severity:** Medium
**Files:** packages/web/src/components/ClaimForm.tsx (StatusBadge)
**Spec ref:** §22

**Description:** StatusBadge shows "checking…" / "claimed" / "unknown". Ineligible (failed 14-day hold check) presents identically to "not yet claimed". User attempts to claim, contract reverts.

**Recommendation:** Pre-flight call to a read function (e.g., `eligibilityFor(address)`) to surface ineligibility before signing.

**Effort:** M

**Status (M-Ux-11, 2026-05-03):** 🚧 DEFER. The client-side pre-flight needs a contract read (`eligibilityFor(address)` or equivalent) that doesn't yet exist on `BonusDistributor` — adding it requires a contract change + redeploy, which is out of scope for a UX polish PR. The `humanizeClaimError` map landed under M-Ux-9 covers the in-the-meantime UX (a clean "This claim is not valid for your wallet…" message instead of a raw revert) so the failure mode is acceptable for Phase 1. Tracked as a Phase 2 backlog item paired with the contract read.

### [UX] Time-window gating not visible in client code
**Severity:** Low → Info
**Files:** packages/web/src/app/claim/bonus/page.tsx
**Spec ref:** §22

**Description:** Spec implies the 14-day hold window gates eligibility; the client doesn't display the gate (e.g., "Bonus opens 2026-05-14"). May be enforced fully on-chain via Merkle root publication time.

**Recommendation:** Surface the bonus window in the page header even if the contract enforces it.

**Effort:** S

**Status (L-Ux-1, 2026-05-03):** ✅ FIXED. `app/claim/bonus/page.tsx` now renders a `<BonusWindowCard>` above the ClaimForm explaining the 14-day hold window in plain English ("When does this open? — Bonus opens 14 days after the season starts. Until then, claims will revert."). Static doc card for Phase 1; future enhancement would read `bonusOpensAt(seasonId)` once the contract exposes it. Pinned by `polishUxFlowsPass.test.tsx` (L-Ux-1 — asserts `BonusWindowCard` ref + the "14 days" copy + the "When does this open?" header).

---

## Flow 7 — Filter moment spectator

### [UX] Slow-network FILTER_FIRED arrival edge case not handled
**Severity:** Low
**Files:** packages/web/src/components/arena/filterMoment/FilterMomentOverlay.tsx
**Spec ref:** §21

**Description:** Reveal animation triggers on FILTER_FIRED event arrival. If the SSE reconnects mid-event or arrives >10 s late, the reveal could fire after the locked window passes, leaving a stale overlay or skipping the recap.

**Recommendation:** Add a fallback: if the event hasn't arrived within `FILTER_MOMENT_WINDOW_MS` of the scheduled cut, render a degraded "Filter just fired — refreshing leaderboard" state and re-fetch /tokens.

**Effort:** M

**Status (L-Ux-2, 2026-05-03):** ✅ FIXED. `FilterMomentOverlay.tsx` defines `FILTER_FIRED_GRACE_SEC = 10` and renders a `<SlowNetworkFallback>` when `secondsUntilCut <= -FILTER_FIRED_GRACE_SEC` while the stage is still stuck in `countdown` (i.e., the wall-clock cut has passed but no FILTER_FIRED event has arrived). Copy: "Filter just fired — refreshing the leaderboard…" The countdown clock surface is preserved so the user can see how late we are. Pinned by `polishUxFlowsPass.test.tsx` (L-Ux-2 — asserts the constant, the helper component, the trigger condition, and the user-facing copy).

### [UX] No survivor-count guard
**Severity:** Low
**Files:** packages/web/src/components/arena/filterMoment/FilterEventReveal.tsx
**Spec ref:** §21

**Description:** Component accepts `survivors` and `filtered` numeric props with no lower bound. If a misconfigured cohort yields 0 survivors, the UI renders "0 SURVIVED" — semantically valid but visually off.

**Recommendation:** Validate `survivors >= 1`; render a fallback if 0.

**Effort:** XS

**Status (L-Ux-3, 2026-05-03):** ✅ FIXED. `FilterEventReveal.tsx` clamps both `survivors` and `filtered` defensively at the top of the component: non-finite or `<1` survivors fall back to `SURVIVE_COUNT` (6), and non-finite or `<0` filtered fall back to the same. The aria-label on the status region uses the clamped value. Pinned by `polishUxFlowsPass.test.tsx` (L-Ux-3 — 5 cases: survivors=0, NaN, -1, valid value, and aria-label clamping).

---

## Audit close-out (2026-05-03)

| ID | Severity | Disposition |
|----|----------|-------------|
| M-Ux-1 | Medium | ✅ FIXED |
| H-Ux-1 (trade panel) | High→Medium | 🚧 DEFER (Phase 2) |
| M-Ux-3 (URL sync) | Low (originally) | ✅ FIXED |
| M-Ux-4 | Medium | ✅ FIXED |
| M-Ux-5 | Medium | ✅ FIXED |
| M-Ux-6 (cost-lock-at-submit) | Medium | ↩ CLOSE-INCIDENTAL (web-general H-Web-2) |
| M-Ux-7 | Medium | ✅ FIXED |
| M-Ux-8 | Medium | ✅ FIXED |
| M-Ux-9 | Medium | ✅ FIXED |
| M-Ux-10 | Low | ✅ FIXED |
| M-Ux-11 (pre-flight bonus eligibility) | Medium | 🚧 DEFER (needs new contract read) |
| L-Ux-1 | Low→Info | ✅ FIXED |
| L-Ux-2 | Low | ✅ FIXED |
| L-Ux-3 | Low | ✅ FIXED |

**Phase 1 Disposition:** 11 fixed, 2 deferred (Phase 2 backlog), 1 close-incidental. All CODE-row fixes pinned by `packages/web/test/regression/polishUxFlowsPass.test.tsx` (28 tests). Behaviour fixes use mounted-component assertions; structural fixes (page-level wiring too heavy for jsdom) use source-grep pins with anti-pattern guards.

---

TOTAL: Critical=0 High=0-1 Medium=8 Low=4 Info=0
