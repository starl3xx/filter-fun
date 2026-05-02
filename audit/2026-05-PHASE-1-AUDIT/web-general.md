# Phase-1 Web (general) Audit
filter.fun web — non-Arena pages and cross-cutting concerns
**Audit Date:** 2026-05-01

---

## CRITICAL

### [Web] Missing error boundary on `/` and `/launch`
**Severity:** Critical
**Files:** packages/web/src/app/page.tsx, packages/web/src/app/launch/page.tsx
**Spec ref:** n/a

**Description:**
Neither the homepage `/` nor `/launch` has an error boundary or graceful fallback UI. `useTokens()`, `useSeason()`, `useTickerEvents()` collect errors in state but the pages do not render them. A failing /tokens or /season call crashes the component tree with no recovery path.

**Recommendation:** Add an error boundary wrapper at the layout level OR render `.error` from each hook with a retry button.

**Effort:** M

### [Web] Claim pages lack wallet balance / wrong-network preflight
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
**Severity:** High
**Files:** packages/web/src/app/launch/page.tsx:100-101, 125
**Spec ref:** n/a

**Description:**
Cost is captured via `costRef.current` so a re-render between user click and write doesn't lose the value — but it also means the *latest* cost (potentially after a slot tier rollover) is what gets sent to the contract. Either is defensible; the ambiguity is the problem.

**Recommendation:** Decide: (a) lock cost at submit (snapshot to state) or (b) accept live cost and document. Prevent the silent surprise.

**Effort:** S

### [Web] ClaimForm proof array under-validated (size + format)
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
**Severity:** High
**Files:** packages/web/src/components/admin/AdminTransferForms.tsx:42
**Spec ref:** §38.6

**Description:**
`pendingAdmin !== "0x0000000000000000000000000000000000000000"` is repeated; if useTokenAdmin returns 0x0 instead of null, stale UI is shown.

**Recommendation:** Normalize in `useTokenAdmin`: map zero-address to `null` so a single source of truth applies everywhere.

**Effort:** XS

### [Web] No useEffect to scroll-to-accept when admin auth state mounts as PENDING
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
**Severity:** Medium
**Files:** packages/web/src/components/ClaimForm.tsx:59-66, 139-143
**Spec ref:** n/a

**Description:**
StatusBadge renders before `alreadyClaimed` settles → flicker. Disconnected wallet hides the entire row → layout shift.

**Recommendation:** Reserve a fixed-height placeholder; render "Connect wallet to check status" when disconnected.

**Effort:** XS

### [Web] LaunchForm submit race — re-validation needed
**Severity:** Medium
**Files:** packages/web/src/components/launch/LaunchForm.tsx:86-95
**Spec ref:** §4.6

**Description:**
`submitDisabled` is computed via useMemo; if a user clicks immediately after typing, the disabled value can still be stale on the click event.

**Recommendation:** Re-validate inside `handleSubmit` before calling `onSubmit`.

**Effort:** S

### [Web] No 375px mobile breakpoint
**Severity:** Medium
**Files:** packages/web/src/app/globals.css (only 1100 / 700 px breakpoints)
**Spec ref:** n/a

**Description:**
No explicit rule for 375 px (iPhone SE). Admin 3-column grid likely breaks badly. Tap targets unverified.

**Recommendation:** Add `@media (max-width: 375px)` rules; ensure ≥44 px tap targets; reduce font sizes.

**Effort:** M

### [Web] Numeric fields not integer-validated on claim
**Severity:** Medium
**Files:** packages/web/src/app/claim/rollover/page.tsx:26-31
**Spec ref:** §22

**Description:**
`BigInt("1.5")` throws — JSON with a fractional `share` or `amount` crashes parsing.

**Recommendation:** Validate `Number.isInteger` before coercing to BigInt; throw a clear error.

**Effort:** XS

### [Web] /launch grid collapses below 1100 px without context
**Severity:** Medium
**Files:** packages/web/src/app/globals.css:270-283, packages/web/src/components/launch/LaunchForm.tsx
**Spec ref:** n/a

**Description:**
On tablet, form stacks below slot grid with no visual hint. Form may feel disconnected from slots.

**Recommendation:** On <1100 px, add an inline hint or move the form above the slot grid.

**Effort:** S

### [Web] Eligibility loading state has no animation
**Severity:** Medium → Low
**Files:** packages/web/src/app/launch/page.tsx:198-203
**Spec ref:** §4.6

**Description:**
Card titled "Checking eligibility…" looks static; no spinner / pulse — user may think the page is stuck.

**Recommendation:** Apply `ff-pulse` to the title or add a small spinner glyph.

**Effort:** XS

### [Web] Metadata API route lacks `import "server-only"`
**Severity:** Medium
**Files:** packages/web/src/app/api/metadata/route.ts
**Spec ref:** n/a

**Description:**
Reads `PINATA_JWT` from env. Next.js makes API routes server-only by default, but explicit declaration prevents accidental client-side import.

**Recommendation:** Add `import "server-only"` at the top.

**Effort:** XS

### [Web] Wagmi RPC env vars not validated
**Severity:** Medium
**Files:** packages/web/src/lib/wagmi.ts:20-22
**Spec ref:** n/a

**Description:**
`http(undefined)` creates a transport that fails silently if env var missing.

**Recommendation:** Throw at module load time if `NEXT_PUBLIC_BASE_RPC_URL` is unset for the active chain.

**Effort:** XS

### [Web] Legacy CSS variable aliases used by ClaimForm
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
**Severity:** Info
**Files:** packages/web/src/lib/launch/storage.ts:46
**Spec ref:** n/a

**Description:** Read inside fetch handler, not exported, not logged. Good posture.

### [Web] Two-step admin transfer correctly gated
**Severity:** Info
**Files:** packages/web/src/components/admin/AdminTransferForms.tsx:16-27,46-54
**Spec ref:** §38.6

**Description:** Nominate → accept flow correctly enforced; PENDING blocks other admin actions.

### [Web] Ticker-collision check debounced (200 ms)
**Severity:** Info
**Files:** packages/web/src/components/launch/LaunchForm.tsx:405-420
**Spec ref:** §4.6

**Description:** Good UX — avoids excessive checks while typing.

---

TOTAL: Critical=3 High=5 Medium=9 Low=1 Info=3
