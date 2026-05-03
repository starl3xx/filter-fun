# Phase-1 Web (general) Audit
filter.fun web — non-Arena pages and cross-cutting concerns
**Audit Date:** 2026-05-01

---

## CRITICAL

### [Web] Missing error boundary on `/` and `/launch`
**Status:** ✅ **FIXED** in audit-remediation PR (Audit Finding C-5). Two layers added per route: (1) Next.js convention `app/error.tsx` + `app/launch/error.tsx` boundaries that catch any thrown render-tree error and present a recoverable card with a `reset()` CTA + `digest` for log correlation; (2) inline `DataErrorBanner` component on both pages that surfaces the polling hooks' captured `.error` (the actual finding — fetch failures don't throw, they just sit in state). Banner sits between the ticker and the grid so it doesn't displace live UI; auto-clears when the next poll succeeds.

**Severity:** Critical
**Files:** packages/web/src/app/page.tsx, packages/web/src/app/launch/page.tsx
**Spec ref:** n/a

**Description:**
Neither the homepage `/` nor `/launch` has an error boundary or graceful fallback UI. `useTokens()`, `useSeason()`, `useTickerEvents()` collect errors in state but the pages do not render them. A failing /tokens or /season call crashes the component tree with no recovery path.

**Recommendation:** Add an error boundary wrapper at the layout level OR render `.error` from each hook with a retry button.

**Effort:** M

### [Web] Claim pages lack wallet balance / wrong-network preflight
**Status:** ✅ **FIXED** in audit-remediation PR (Audit Finding C-6). Two-layer preflight gates the claim CTA: (1) chain check — wallet must be on `chain.id` from `lib/wagmi.ts`, with a one-click `useSwitchChain` CTA if not; (2) balance check — `useBalance` for the chain's native asset, must be `> 0n`. Order is load-bearing (chain before balance) so the wrong-chain user gets the actionable fix instead of a misleading "no balance" message. Decision logic extracted as pure `computeClaimPreflight()` and unit-tested at `test/claim/computeClaimPreflight.test.ts` (6 cases, including the load-bearing "loading == fail closed" rule that prevents future refactors from silently flipping the default to permissive).

**Severity:** Critical
**Files:** packages/web/src/components/ClaimForm.tsx:88-99
**Spec ref:** §22

**Description:**
ClaimForm calls `writeContract` without any preflight: no insufficient-ETH-for-gas check, no wrong-chain check. User pastes JSON, presses Claim, and gets a contract revert instead of a helpful warning.

**Evidence:**
```tsx
function handleClaim() {
  if (!parsed) return;
  const call = buildCall(parsed);
  writeContract({address: call.address, abi: call.abi as never, functionName: call.functionName, args: call.args as never});
}
```

**Recommendation:** Disable the claim CTA unless connected + on correct chain + balance > estimated gas. Surface a clear message for each failure mode.

**Effort:** S

### [Web] Admin console has no error UI for failed hook reads
**Status:** ✅ **FIXED** in audit-remediation PR (Audit Finding C-7). Coalesced `useTokenAdmin.error`, `useStakeStatus.error`, `useSeason.error`, `useTokens.error` into a single `liveDataError` chip rendered in the center column above the live panels via the new `LiveDataErrorCard`. The chip keeps the live panels mounted (so partial data is still visible) and surfaces the upstream error message. The polling hooks reset `error` to null on the next successful fetch — the next poll IS the retry, so no manual button is offered (which would risk masking a recurring failure).

**Severity:** Critical
**Files:** packages/web/src/app/token/[address]/admin/page.tsx:64-70
**Spec ref:** §38

**Description:**
useTokenAdmin / useSeason / useTokenStats / useAdminAuth all silently return undefined on RPC failure. The admin page renders a broken/blank middle column without telling the user what happened.

**Recommendation:** Check `.error` from each hook; render an error card in the center column with a retry CTA.

**Effort:** M

---

## HIGH

### [Web] Wagmi config supports only `injected()` connector
**Status:** ✅ **FIXED** in `audit/web-high-batch-3` (Audit H-Web-1). `wagmi/connectors` exports `coinbaseWallet` + `walletConnect` are wired alongside `injected()`. Order: `injected()` first (desktop default — MetaMask / Rabby), `coinbaseWallet({appName: "filter.fun"})` second (large Base userbase), `walletConnect({projectId})` last (mobile via QR pairing). `NEXT_PUBLIC_WC_PROJECT_ID` documented in `packages/web/.env.example` — production deploys MUST provision a project ID at cloud.walletconnect.com or WC will silently fail at pair time. Pinned by `wagmiConnectors.test.ts` (5 tests covering import, ordering, appName, env-var wiring, and .env.example documentation).

**Severity:** High
**Files:** packages/web/src/lib/wagmi.ts:16-24
**Spec ref:** n/a

**Description:**
Only MetaMask/Rabby (and other injected) wallets can connect. Coinbase Wallet (a stated target wallet) and WalletConnect-based mobile wallets are excluded.

**Evidence:**
```ts
connectors: [injected()],
```

**Recommendation:** Add `coinbaseWallet()` and `walletConnect({projectId})` connectors. WC project id from env.

**Effort:** S

### [Web] Stale-closure mitigation in LaunchForm onSubmit reads live ref
**Status:** ✅ **FIXED** in `audit/web-high-batch-3` (Audit H-Web-2). `costRef` pattern removed entirely; `onSubmit` now snapshots `{slotIndex, nextCostWei, stakeWei}` at the moment of click and passes `snap.nextCostWei + snap.stakeWei` to the launch tx — guaranteeing the user pays the price they saw, not whatever the live cost has rolled to during the IPFS pin. A `SnapshotBadge` renders during the pinning/signing/broadcasting window so the user has the cost commitment in front of them. On revert (slot taken / under-payment after a tier rollover) the existing `humanError` mapping in `useLaunchToken` surfaces a friendly message and the user can re-submit with the new cost. Follow-up: Epic 1.15 should add a `reserve(uint8 slotIndex)` with `error SlotTaken(uint8)` so we can distinguish "slot taken" from "tier rolled over" — both surface as `InsufficientPayment` today.

**Severity:** High
**Files:** packages/web/src/app/launch/page.tsx:100-101, 125
**Spec ref:** n/a

**Description:**
Cost is captured via `costRef.current` so a re-render between user click and write doesn't lose the value — but it also means the *latest* cost (potentially after a slot tier rollover) is what gets sent to the contract. Either is defensible; the ambiguity is the problem.

**Recommendation:** Decide: (a) lock cost at submit (snapshot to state) or (b) accept live cost and document. Prevent the silent surprise.

**Effort:** S

### [Web] ClaimForm proof array under-validated (size + format)
**Status:** ✅ **FIXED** in `audit/web-high-batch-3` (Audit H-Web-3). New shared validator `packages/web/src/lib/claim/validateProof.ts` with `MAX_PROOF_LENGTH = 32` (Merkle depth 32 → up to 2^32 leaves, far more than any realistic season). Validator throws on: non-array / null / undefined / empty array / >32 entries / non-string item / non-hex item / wrong-length hex (not 64 hex chars after `0x`) / non-`0x`-prefixed item. Wired into both `parseRollover` and `parseBonus`. Pinned by `validateProof.test.ts` (9 tests covering each rejection path + the smallest and largest valid cases + mixed-case hex acceptance).

**Severity:** High
**Files:** packages/web/src/app/claim/rollover/page.tsx:23-24, packages/web/src/app/claim/bonus/page.tsx:23-24
**Spec ref:** §22

**Description:**
Proof is checked to be array of strings; but no length cap, no empty check, no per-item hex validation. A user could paste a 10000-element array and OOM the wallet RPC, or pass non-hex strings that revert with confusing errors.

**Recommendation:**
```ts
if (o.proof.length === 0) throw new Error("proof cannot be empty");
if (o.proof.length > 32) throw new Error("proof too long");
if (!o.proof.every((p) => /^0x[0-9a-f]{64}$/i.test(p))) throw new Error("each item must be a 32-byte hex string");
```

**Effort:** XS

### [Web] AdminTransferForms zero-address check duplicated
**Status:** ✅ **FIXED** in `audit/web-high-batch-3` (Audit H-Web-4). `useTokenAdmin` already normalizes `address(0)` → `null` for every address field (the `nullIfZero` helper landed in the C-7 remediation). The duplicated string-literal compare in `AdminTransferForms.tsx:42` was dead but masked a dangerous fallback — if the hook ever stopped normalising, the literal check would silently keep the UI working on raw `0x0000…` data. Trust the hook's contract: `hasPending = pendingAdmin !== null`. Audit-driven cleanup also routed user-input zero-address checks (`AdminTransferForms` NominateForm + `RecipientForm`) through the existing shared `isZeroAddress()` helper in `lib/token/format.ts` — single predicate across the codebase, catches case variants. Pinned by `useTokenAdminZeroAddress.test.ts` (4 tests covering hook-level normalization, the post-fix `=== null` consumer pattern, and the absence of any `0x0000…` string literals in the touched components).

**Severity:** High
**Files:** packages/web/src/components/admin/AdminTransferForms.tsx:42
**Spec ref:** §38.6

**Description:**
`pendingAdmin !== "0x0000000000000000000000000000000000000000"` is repeated; if useTokenAdmin returns 0x0 instead of null, stale UI is shown.

**Recommendation:** Normalize in `useTokenAdmin`: map zero-address to `null` so a single source of truth applies everywhere.

**Effort:** XS

### [Web] No useEffect to scroll-to-accept when admin auth state mounts as PENDING
**Status:** ✅ **FIXED** in `audit/web-high-batch-3` (Audit H-Web-5). New `useEffect` keyed on `auth.state` smooth-scrolls the accept-form anchor into view whenever the page transitions to PENDING (covers both initial-mount-as-PENDING and DISCONNECTED → PENDING after wallet connect). Paired with a 2-second pulse outline on the AdminTransferForms wrapper (via the new `pulseAccept` prop + `ff-pulse` keyframe) so the visual anchor matches the scroll target. Pinned by `adminScrollToAccept.test.ts` (5 tests covering the effect's dep array, the scrollIntoView shape, the pulse timeout, the pulse threading from page → component, and the data-pulse-accept attribute on the wrapper).

**Severity:** High
**Files:** packages/web/src/app/token/[address]/admin/page.tsx:100-102, 137
**Spec ref:** §38.6

**Description:**
`onScrollToAccept` only fires on user interaction; if the page loads with auth.state already PENDING, the user must hunt for the form.

**Recommendation:**
```tsx
useEffect(() => {
  if (auth.state === "PENDING") acceptAnchorRef.current?.scrollIntoView({behavior: "smooth", block: "center"});
}, [auth.state]);
```

**Effort:** XS

---

## MEDIUM

### [Web] ClaimForm status badge flicker / layout shift
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-1). Two changes pin the contract: (1) the Status row inside the parsed-section now renders unconditionally — the connect/disconnect choice happens INSIDE the row (renders the StatusBadge when connected, "Connect wallet to check status" placeholder when not) so a wallet event no longer collapses the row and shifts the layout below; (2) StatusBadge composes its style from a `baseStyle` object that sets `display: "inline-block"`, `minHeight: 18`, `lineHeight: "18px"` so the text swap from "checking…" → "eligible" / "already claimed" doesn't flicker the row height. Both pinned by `polishWebPass.test.tsx` (3 tests covering the always-render shape, the min-height reservation, and the disconnected placeholder copy).

**Severity:** Medium
**Files:** packages/web/src/components/ClaimForm.tsx:59-66, 139-143
**Spec ref:** n/a

**Description:**
StatusBadge renders before `alreadyClaimed` settles → flicker. Disconnected wallet hides the entire row → layout shift.

**Recommendation:** Reserve a fixed-height placeholder; render "Connect wallet to check status" when disconnected.

**Effort:** XS

### [Web] LaunchForm submit race — re-validation needed
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-2). `handleSubmit` now re-derives validation against the live `fields` + `cohort` inside the click handler before calling the parent's `onSubmit`, instead of trusting the memoised `submitDisabled`. The check covers field-level validators, ticker collision, the acknowledged checkbox, and the in-flight phase guards. Pinned by `polishWebPass.test.tsx` (3 tests asserting the live `validateLaunchFields(fields)` call, the live `cohort.some` collision check, and the `if (submitDisabled || liveBlocked) return` short-circuit).

**Severity:** Medium
**Files:** packages/web/src/components/launch/LaunchForm.tsx:86-95
**Spec ref:** §4.6

**Description:**
`submitDisabled` is computed via useMemo; if a user clicks immediately after typing, the disabled value can still be stale on the click event.

**Recommendation:** Re-validate inside `handleSubmit` before calling `onSubmit`.

**Effort:** S

### [Web] No 375px mobile breakpoint
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-3). Adds an explicit `@media (max-width: 375px)` block to globals.css covering: (1) tighter body font size (13 px) so chrome doesn't crowd data; (2) reduced padding on `.ff-arena-grid` / `.ff-launch-page` / non-arena/launch `<main>`; (3) WCAG 2.5.5 compliant 44 px min tap targets enforced on `<button>` / `[role="button"]` / `<input type="button|submit">` inside `<main>` (min-width 44 only on `<button>` so non-button chips don't widen); (4) launch slot grid pulled from 2-col to single-col so each card gets the full SE viewport width. Pinned by `polishWebPass.test.tsx` (2 tests covering the media block existence and the 44 px rule presence).

**Severity:** Medium
**Files:** packages/web/src/app/globals.css (only 1100 / 700 px breakpoints)
**Spec ref:** n/a

**Description:**
No explicit rule for 375 px (iPhone SE). Admin 3-column grid likely breaks badly. Tap targets unverified.

**Recommendation:** Add `@media (max-width: 375px)` rules; ensure ≥44 px tap targets; reduce font sizes.

**Effort:** M

### [Web] Numeric fields not integer-validated on claim
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-4). New `lib/claim/parseInteger.ts` exports `toIntegerBigInt(value, fieldName)` which: accepts JS integer numbers + strict decimal-integer strings (with optional leading `-` and surrounding whitespace), rejects fractional / NaN / Infinity / empty / hex-form / scientific-notation inputs with a field-named `Error` message ("share must be an integer (got 1.5)") instead of the opaque low-level `BigInt` SyntaxError. Wired into both `parseRollover` (rollover page) and `parseBonus` (bonus page) for the `seasonId` + `share`/`amount` fields. Pinned by `polishWebPass.test.tsx` (10 tests covering each acceptance + rejection path, including the `"0xff"` and `"1e18"` cases that raw `BigInt` would otherwise accept).

**Severity:** Medium
**Files:** packages/web/src/app/claim/rollover/page.tsx:26-31
**Spec ref:** §22

**Description:**
`BigInt("1.5")` throws — JSON with a fractional `share` or `amount` crashes parsing.

**Recommendation:** Validate `Number.isInteger` before coercing to BigInt; throw a clear error.

**Effort:** XS

### [Web] /launch grid collapses below 1100 px without context
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-5). Adds a `<div className="ff-launch-stack-hint">` element inside the form column on `/launch` carrying the cyan informational chip "↑ Pick / inspect a slot above · Launch form ↓". CSS hides the element by default (`display: none`) and surfaces it inside the existing `@media (max-width: 1100px)` block — desktop is unchanged; the hint only appears when the form drops below the slot grid. Uses `color-mix(in srgb, var(--cyan), transparent)` for the chip's tinted border + background, falling back to the Tailwind-free CSS-vars approach to keep the styling local. Pinned by `polishWebPass.test.tsx` (3 tests covering the JSX render of the class, the default `display: none`, and the `display: block` override inside the < 1100 px block).

**Severity:** Medium
**Files:** packages/web/src/app/globals.css:270-283, packages/web/src/components/launch/LaunchForm.tsx
**Spec ref:** n/a

**Description:**
On tablet, form stacks below slot grid with no visual hint. Form may feel disconnected from slots.

**Recommendation:** On <1100 px, add an inline hint or move the form above the slot grid.

**Effort:** S

### [Web] Eligibility loading state has no animation
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-6). `NoticeCard` accepts a new `pulseTitle?: boolean` prop; when true, the title node carries `className="ff-pulse"` (the existing 1.4 s ease-in-out keyframe already declared in globals.css). The launch page passes `pulseTitle={eligibility.state === "loading"}` so the pulse fires only for the actively-loading state — `already-launched` / `window-closed` / `not-connected` final states stay calm so the pulse remains a "work in flight" signal, not chrome. The `ff-pulse` keyframe is already gated by `prefers-reduced-motion` (line 168 of globals.css), so the change inherits accessibility for free. Pinned by `polishWebPass.test.tsx` (2 tests covering the page → component prop threading and the `className="ff-pulse"` assignment shape).

**Severity:** Medium → Low
**Files:** packages/web/src/app/launch/page.tsx:198-203
**Spec ref:** §4.6

**Description:**
Card titled "Checking eligibility…" looks static; no spinner / pulse — user may think the page is stuck.

**Recommendation:** Apply `ff-pulse` to the title or add a small spinner glyph.

**Effort:** XS

### [Web] Metadata API route lacks `import "server-only"`
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-7). Added `import "server-only";` at the top of `packages/web/src/app/api/metadata/route.ts` (above all other imports). Next.js routes are server-only by default — this explicit import upgrades the leak from "silent code review miss" to "build-time error" if a future shared util re-exports anything from this file into a client bundle. Vitest doesn't ship the `server-only` resolver natively, so a tiny stub at `test/stubs/server-only.ts` is wired via `vitest.config.ts` `resolve.alias` to a no-op module (the production guarantee still holds because next compiles through its own resolver). Pinned by `polishWebPass.test.tsx` (1 test asserting the import line exists AND precedes the `next/server` import) plus the existing `test/launch/api.metadata.test.ts` continues to import and exercise the route module.

**Severity:** Medium
**Files:** packages/web/src/app/api/metadata/route.ts
**Spec ref:** n/a

**Description:**
Reads `PINATA_JWT` from env. Next.js makes API routes server-only by default, but explicit declaration prevents accidental client-side import.

**Recommendation:** Add `import "server-only"` at the top.

**Effort:** XS

### [Web] Wagmi RPC env vars not validated
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-8). `lib/wagmi.ts` now derives the *expected* env-var name from the active chain (`NEXT_PUBLIC_BASE_RPC_URL` for Base, `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` for Base Sepolia) and validates at module load: throws an `Error` in production builds (`NODE_ENV === "production"`) with the env-var name + chain name in the message; logs a `console.warn` in dev/test where falling back to viem's public RPC is the intended developer-friction-free behaviour. The split is load-bearing — vitest sets `NODE_ENV === "test"` and the suite must keep importing the wagmi config without provisioning a real RPC. Pinned by `polishWebPass.test.tsx` (3 tests covering the env-name derivation, the production-only `throw new Error(message)`, and the dev/test `console.warn(message)` path).

**Severity:** Medium
**Files:** packages/web/src/lib/wagmi.ts:20-22
**Spec ref:** n/a

**Description:**
`http(undefined)` creates a transport that fails silently if env var missing.

**Recommendation:** Throw at module load time if `NEXT_PUBLIC_BASE_RPC_URL` is unset for the active chain.

**Effort:** XS

### [Web] Legacy CSS variable aliases used by ClaimForm
**Status:** ✅ **FIXED** in `audit/polish-web-general` (Polish 3 — Audit M-Web-9). ClaimForm.tsx switched off all `var(--fg|muted|border|accent)` references — now imports `C` from `@/lib/tokens` and uses `C.text` / `C.dim` / `C.line` / `C.pink` directly inline. The legacy aliases were the SOLE consumer (verified via grep across the web src tree before deletion); with the consumer removed, the four legacy `--fg` / `--muted` / `--border` / `--accent` declarations were deleted from the `:root` block in globals.css. Single source of truth: design tokens live in `lib/tokens.ts` for inline-style use; CSS var declarations in globals.css mirror the live design system only. Pinned by `polishWebPass.test.tsx` (4 tests asserting ClaimForm carries no legacy var refs, the `from "@/lib/tokens"` import is present, the globals.css `:root` block no longer declares the four aliases, and a styled-span smoke render works).

**Severity:** Medium → Low
**Files:** packages/web/src/components/ClaimForm.tsx, packages/web/src/app/globals.css:19-23
**Spec ref:** n/a

**Description:**
ClaimForm uses `var(--fg)`, `var(--muted)`, `var(--border)`, `var(--accent)` (legacy). New design system uses `--text`, `--dim`, `--line`, `--pink` — the legacy aliases will rot if removed.

**Recommendation:** Refactor to import from `@/lib/tokens` like other pages, or remove the legacy aliases after switching the form.

**Effort:** S

---

## LOW

### [Web] Dead code — `walletFilteredTickers` always returns []
**Status:** 🚧 **DEFERRED** to Phase 2 in `audit/polish-web-general` (Polish 3 — Audit L-Web-1). The audit's own recommendation says "no action — wire when `/wallets/{address}/holdings` ships." The endpoint isn't part of Phase 1 (concentration filtering / per-wallet holdings is Phase-2 scope per ROADMAP); the inline comment + TODO is the breadcrumb future work picks up. No code change in this PR.

**Severity:** Low
**Files:** packages/web/src/app/page.tsx:179-188
**Spec ref:** n/a

**Description:**
TODO documents that the indexer endpoint isn't ready. Useful breadcrumb but currently inert.

**Recommendation:** No action — wire when `/wallets/{address}/holdings` ships.

**Effort:** n/a

---

## INFO

### [Web] PINATA_JWT correctly server-only in storage helper
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-web-general` (Polish 3 — Audit I-Web-1). Re-inspection confirms `storage.ts` reads `PINATA_JWT` only inside the fetch handler scope, never exports it, never logs it. The companion fix landed under Audit M-Web-7 (the explicit `import "server-only"` on the route) provides build-time enforcement of the same posture for the route module that calls into this helper. No code change in this PR.

**Severity:** Info
**Files:** packages/web/src/lib/launch/storage.ts:46
**Spec ref:** n/a

**Description:** Read inside fetch handler, not exported, not logged. Good posture.

### [Web] Two-step admin transfer correctly gated
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-web-general` (Polish 3 — Audit I-Web-2). Re-inspection confirms the AdminTransferForms two-step flow is correctly enforced: PENDING blocks other admin actions and the contract-level enforcement is double-checked via the existing `useTokenAdminZeroAddress.test.ts` regression bundle (which pinned the H-Web-4 `pendingAdmin !== null` simplification). No code change in this PR.

**Severity:** Info
**Files:** packages/web/src/components/admin/AdminTransferForms.tsx:16-27,46-54
**Spec ref:** §38.6

**Description:** Nominate → accept flow correctly enforced; PENDING blocks other admin actions.

### [Web] Ticker-collision check debounced (200 ms)
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-web-general` (Polish 3 — Audit I-Web-3). Re-inspection confirms the 200 ms debounce in `useTickerCollision` (now at `LaunchForm.tsx:419-434` after the M-Web-2 handleSubmit edits). Audit M-Web-2's live-revalidation also runs the collision check at click time, so the user-observable contract is "debounced while typing, definitive at submit." No code change in this PR.

**Severity:** Info
**Files:** packages/web/src/components/launch/LaunchForm.tsx:405-420
**Spec ref:** §4.6

**Description:** Good UX — avoids excessive checks while typing.

---

TOTAL: Critical=3 High=5 Medium=9 Low=1 Info=3
