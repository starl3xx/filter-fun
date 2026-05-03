# Frontend Security Audit
**Audit Date:** 2026-05-01

---

## CRITICAL
None.

## HIGH

### [Security] No Content-Security-Policy headers configured
**Status:** ✅ **FIXED** in `audit/polish-security` (Polish 10 — Audit H-Sec-CSP). The High row was missed in the High-batch dispatch and per POLISH_PLAN.md was deliberately carried into the Polish 10 PR because the surrounding security PR is its natural home. `packages/web/next.config.mjs` now exports `async headers()` returning a CSP plus four defense-in-depth headers (X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy locking down camera/mic/geo/payment) on every route via `source: "/(.*)"`. The CSP allowlists `'self'` for default/script/style/font/img with the wagmi-required `'wasm-unsafe-eval'` (viem's wasm crypto primitives), `connect-src` for the indexer URL + Pinata + the *.base.org / *.publicnode.com viem fallback hosts + the *.walletconnect.com/.org WebSocket hosts WC v2 needs, `frame-ancestors 'none'` paired with X-Frame-Options for clickjacking defense, and `base-uri 'self'` + `form-action 'self'` to prevent base-tag hijack and form exfiltration. Each directive carries an inline-comment rationale in `next.config.mjs` so a future maintainer can see why each piece is load-bearing. Pinned by `polishSecurityPass.test.tsx` (4 tests: async headers shape, every-route source pattern, CSP directive presence + negative anti-`unsafe-eval` + anti-`*` checks, four non-CSP defense headers).

**Severity:** High
**Files:** packages/web/next.config.mjs
**Spec ref:** n/a

**Description:** App loads external scripts (Google Fonts) and connects to api.filter.fun + api.pinata.cloud. With no CSP, an XSS injection could exfiltrate wallet state or mutate transactions.

**Recommendation:** Add `async headers()` returning at minimum:
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://api.filter.fun https://api.pinata.cloud; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:;
```
Tune as needed.

**Effort:** S

---

## MEDIUM

### [Security] PINATA_JWT scoped server-only — confirmed; deployment doc lacks explicit warning
**Status:** 📋 **DOC** in `audit/polish-security` (Polish 10 — Audit M-Sec-1). Two doc surfaces updated. (1) `packages/web/.env.example` now carries a "Metadata pinning" block with PINATA_JWT + METADATA_STORE_DIR + METADATA_PUBLIC_URL keys, each with the explicit warning that they must NOT be prefixed `NEXT_PUBLIC_` (the Next.js bundler exposes any `NEXT_PUBLIC_*` env to the browser; renaming `PINATA_JWT` → `NEXT_PUBLIC_PINATA_JWT` would leak the JWT to every visitor). (2) `docs/runbook-operator.md` §1.7 added a pre-week check: an explicit `kubectl exec deploy/web -- env | grep NEXT_PUBLIC_PINATA` step that must return empty, with a rotation instruction if anything matches.

**Severity:** Medium
**Files:** packages/web/src/lib/launch/storage.ts:46, src/app/api/metadata/route.ts
**Spec ref:** PR #39

**Description:** PINATA_JWT is read only inside server-side route handler, never exposed via NEXT_PUBLIC. Posture is correct. However, the runbook and `.env.example` should warn explicitly: never set `NEXT_PUBLIC_PINATA_JWT`.

**Recommendation:** Add a comment in `.env.example` (if it exists; create one if not) and runbook-operator.md: "PINATA_JWT — server-only; do not prefix NEXT_PUBLIC_."

**Effort:** XS

### [Security] Image URL validated as HTTPS-only but no redirect / data-URI check
**Status:** ✅ **FIXED** in `audit/polish-security` (Polish 10 — Audit M-Sec-2). New `checkImageUrlSafe(url)` helper inside `packages/web/src/app/api/metadata/route.ts` runs after the regex validation pass and HEAD-fetches the image URL with `redirect: "manual"` + a 7-second `AbortSignal.timeout`, then:
- 200 / 204 / 206 → accept (URL resolves directly).
- 3xx with a `Location` that doesn't start with `https://` (covers `data:`, `http://`, `javascript:`, missing) → reject with a per-field error.
- 3xx with an `https://` `Location` → accept (one hop allowed; recursive chasing opens an SSRF / latency budget the per-launch handler can't afford).
- 4xx / 5xx / network failure / timeout → reject.

The helper runs before `activeBackend()` so a bad URL never wastes a Pinata pin call. Pinned by `polishSecurityPass.test.tsx` (6 tests: 200 OK accept, `data:` redirect reject, `http://` redirect reject, https → https one-hop accept, 404 reject, network-error reject). The existing `api.metadata.test.ts` was updated to default-mock the HEAD-check fetch in `beforeEach` so its 8 tests still pass.

**Severity:** Medium
**Files:** packages/web/src/lib/launch/validation.ts (HTTPS_RE check)
**Spec ref:** n/a

**Description:** Server-side metadata pin should HEAD the URL and reject 3xx redirects to non-HTTPS or to data: schemes. Client doesn't sanitize before display.

**Recommendation:** Server: HEAD-check + redirect inspection in metadata route. Client: keep all image render via `<img>` (no `dangerouslySetInnerHTML` found — good); add DOMPurify if metadata text ever renders.

**Effort:** M

### [Security] Form validation client-side only — no server re-validation guaranteed
**Status:** ↩ **CLOSE-INCIDENTAL** in `audit/polish-security` (Polish 10 — Audit M-Sec-3). Already done. The `/api/metadata` route handler at `packages/web/src/app/api/metadata/route.ts:51-55` already runs `coerceLaunchFields(raw)` to shape-coerce the unknown JSON, then `validateLaunchFields(body)` to re-run the same validators the client uses, returning a structured 400 with per-field errors before any backend call. The audit was working from a stale snapshot. No code change in this PR (the M-Sec-2 image HEAD-check is layered on top of this existing validation pass).

**Severity:** Medium
**Files:** packages/web/src/app/api/metadata/route.ts vs packages/web/src/lib/launch/validation.ts
**Spec ref:** n/a

**Description:** Defense-in-depth principle. Server route should re-run validateLaunchFields (or equivalent) before pinning metadata. Verify the route does this.

**Recommendation:** Read route handler; if it doesn't re-validate, add the same validators server-side.

**Effort:** S

---

## LOW

### [Security] No Subresource Integrity for Google Fonts
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-security` (Polish 10 — Audit L-Sec-1). Re-verified — `packages/web/src/app/layout.tsx` carries no raw `<link>` to fonts.googleapis.com / fonts.gstatic.com (grep clean). The fonts are loaded via `next/font/google`, which fetches and self-hosts at build time under `/_next/static/media/` — SRI on a runtime CDN link is not applicable when the font is part of the build output. No code change.

**Severity:** Low
**Files:** packages/web/src/app/layout.tsx
**Spec ref:** n/a

**Description:** next/font fetches and self-hosts Google Fonts at build time, mitigating most CDN-tampering risk. SRI on the runtime <link> isn't needed when next/font is used.

**Recommendation:** Verify fonts are self-hosted (next/font/google does this). If layout adds raw `<link>` to fonts.googleapis.com, add `integrity`.

**Effort:** XS

### [Security] CORS not documented for client→Pinata
**Status:** 📋 **DOC** in `audit/polish-security` (Polish 10 — Audit L-Sec-2). Comment block added above `pinToPinata` in `packages/web/src/lib/launch/storage.ts` documenting that this fetch is server-side only (the route handler is the only call site, the JWT lives in a non-`NEXT_PUBLIC_` env var per M-Sec-1) and warning future maintainers not to move the fetch client-side — doing so would require shipping the JWT to the browser bundle (instant credential leak) and would fail the cross-origin preflight Pinata's API doesn't currently allow.

**Severity:** Low
**Files:** packages/web/src/lib/launch/storage.ts:49-56
**Spec ref:** n/a

**Description:** All Pinata calls server-mediated; CORS not relevant client-side. Add a comment to prevent future client-direct attempts.

**Recommendation:** One-line code comment.

**Effort:** XS

---

## INFO

### [Security] No `dangerouslySetInnerHTML` usage anywhere
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-security` (Polish 10 — Audit I-Sec-1). Re-verified `grep -rn 'dangerouslySetInnerHTML' packages/web/src` returns zero matches. Posture preserved. No code change.

**Severity:** Info
**Files:** packages/web/src
**Spec ref:** n/a

PASS — grep clean.

---

TOTAL: Critical=0 High=1 Medium=3 Low=2 Info=1
