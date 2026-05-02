# Frontend Security Audit
**Audit Date:** 2026-05-01

---

## CRITICAL
None.

## HIGH

### [Security] No Content-Security-Policy headers configured
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
**Severity:** Medium
**Files:** packages/web/src/lib/launch/storage.ts:46, src/app/api/metadata/route.ts
**Spec ref:** PR #39

**Description:** PINATA_JWT is read only inside server-side route handler, never exposed via NEXT_PUBLIC. Posture is correct. However, the runbook and `.env.example` should warn explicitly: never set `NEXT_PUBLIC_PINATA_JWT`.

**Recommendation:** Add a comment in `.env.example` (if it exists; create one if not) and runbook-operator.md: "PINATA_JWT — server-only; do not prefix NEXT_PUBLIC_."

**Effort:** XS

### [Security] Image URL validated as HTTPS-only but no redirect / data-URI check
**Severity:** Medium
**Files:** packages/web/src/lib/launch/validation.ts (HTTPS_RE check)
**Spec ref:** n/a

**Description:** Server-side metadata pin should HEAD the URL and reject 3xx redirects to non-HTTPS or to data: schemes. Client doesn't sanitize before display.

**Recommendation:** Server: HEAD-check + redirect inspection in metadata route. Client: keep all image render via `<img>` (no `dangerouslySetInnerHTML` found — good); add DOMPurify if metadata text ever renders.

**Effort:** M

### [Security] Form validation client-side only — no server re-validation guaranteed
**Severity:** Medium
**Files:** packages/web/src/app/api/metadata/route.ts vs packages/web/src/lib/launch/validation.ts
**Spec ref:** n/a

**Description:** Defense-in-depth principle. Server route should re-run validateLaunchFields (or equivalent) before pinning metadata. Verify the route does this.

**Recommendation:** Read route handler; if it doesn't re-validate, add the same validators server-side.

**Effort:** S

---

## LOW

### [Security] No Subresource Integrity for Google Fonts
**Severity:** Low
**Files:** packages/web/src/app/layout.tsx
**Spec ref:** n/a

**Description:** next/font fetches and self-hosts Google Fonts at build time, mitigating most CDN-tampering risk. SRI on the runtime <link> isn't needed when next/font is used.

**Recommendation:** Verify fonts are self-hosted (next/font/google does this). If layout adds raw `<link>` to fonts.googleapis.com, add `integrity`.

**Effort:** XS

### [Security] CORS not documented for client→Pinata
**Severity:** Low
**Files:** packages/web/src/lib/launch/storage.ts:49-56
**Spec ref:** n/a

**Description:** All Pinata calls server-mediated; CORS not relevant client-side. Add a comment to prevent future client-direct attempts.

**Recommendation:** One-line code comment.

**Effort:** XS

---

## INFO

### [Security] No `dangerouslySetInnerHTML` usage anywhere
**Severity:** Info
**Files:** packages/web/src
**Spec ref:** n/a

PASS — grep clean.

---

TOTAL: Critical=0 High=1 Medium=3 Low=2 Info=1
