# Documentation Audit
**Audit Date:** 2026-05-01

---

## CRITICAL
None.

## HIGH

### [Docs] runbook-operator.md doesn't cross-reference the bag-lock pre-1.13 caveat
**Severity:** High
**Files:** docs/runbook-operator.md (§5.6 bag-lock procedure), docs/bag-lock.md:87-97
**Spec ref:** PR #43, §38

**Description:** bag-lock.md notes legacy Sepolia tokens (pre-1.13) cannot be bag-locked even if the call appears to succeed. The operator runbook does not link to or reproduce this warning. An operator could "lock" a legacy token and silently get no enforcement.

**Recommendation:** Add a callout in runbook-operator.md §5.6: "Verify the token was deployed AFTER the Epic 1.13 FilterFactory redeploy. See docs/bag-lock.md §5 for legacy-token caveat." Or, surface this in the admin UI as a badge.

**Effort:** S

### [Docs] runbook-sepolia-smoke.md gas figure may be stale post-Epic 1.13
**Severity:** High → Medium
**Files:** docs/runbook-sepolia-smoke.md:20-21
**Spec ref:** n/a

**Description:** "0.5 ETH recommended" hasn't been re-validated since invariant suite + bag-lock contracts shipped. Underfunded operators may fail mid-deploy.

**Recommendation:** Re-run on Sepolia, capture actual cost, update the doc with margin (e.g., "0.X ETH; budget 0.X+0.2 ETH").

**Effort:** M

---

## MEDIUM

### [Docs] runbook-operator.md cadence table has no drift tolerance
**Status:** 📋 **DOC** in `audit/polish-docs` (Polish 8 — Audit M-Docs-1). New "Drift tolerance & escalation" subsection added immediately after the cadence table in `docs/runbook-operator.md` §0. Pins ±2 min as on-cadence, >5 min as escalate-to-oncall, lists likely root causes (scheduler crash / RPC degraded / gas spike / key revoked), and explicitly warns not to manually fire while waiting (a manual `advancePhase` racing against an in-flight scheduler tx will revert one and burn gas).

**Severity:** Medium
**Files:** docs/runbook-operator.md:20-38
**Spec ref:** §3.2

**Description:** Cadence table is deterministic (hours 0/48/96/168). No tolerance window: when should an operator escalate if the cut is late?

**Recommendation:** Add a paragraph: "The hard cut should fire within ±2 minutes of the scheduled hour. >5 min late → escalate. Do not manually fire while waiting."

**Effort:** S

### [Docs] zombie-tokens.md not linked from README
**Status:** ↩ **CLOSE-INCIDENTAL** in `audit/polish-docs` (Polish 8 — Audit M-Docs-2). Already linked. The README's "Operator runbooks" line (line 8) lists `docs/zombie-tokens.md` alongside the operator + sepolia-smoke + bag-lock runbooks. The audit was working from a stale README snapshot. No code change in this PR.

**Severity:** Medium
**Files:** README.md (no link to zombie-tokens.md)
**Spec ref:** n/a

**Description:** zombie-tokens.md is comprehensive but not surfaced in the docs index. New operators may not know filtered tokens remain tradable on Uniswap.

**Recommendation:** Add a one-line ref under Operator runbooks in README.

**Effort:** XS

### [Docs] README doesn't note Sepolia redeploy status post-Epic 1.13
**Status:** 📋 **DOC** in `audit/polish-docs` (Polish 8 — Audit M-Docs-3). The Base Sepolia bullet under "Deploying" now includes the redeploy date (2026-05-01), the Epic 1.13 contracts that landed (FilterFactory v2 + CreatorCommitments + CreatorRegistry), the corrected manifest path (`packages/contracts/deployments/base-sepolia.json` — root-relative), and a cross-reference to the bag-lock legacy-token caveat at `docs/bag-lock.md` §5. The path correction also addresses the H-Docs-1 cross-ref gap from the High row above (operators landing on the README see the legacy-token warning before they touch the runbook).

**Severity:** Medium
**Files:** README.md:52
**Spec ref:** n/a

**Description:** Clarify whether the bag-lock contracts are already on Sepolia, and link to deployment manifest.

**Recommendation:** Add: "Sepolia redeployed 2026-05-01 with Epic 1.13 contracts; addresses in `packages/contracts/deployments/base-sepolia.json`."

**Effort:** S

---

## LOW

### [Docs] AGENTS.md URL canon doesn't mention staging/preview pattern
**Status:** 📋 **DOC** in `audit/polish-docs` (Polish 8 — Audit L-Docs-1). New paragraph added under the "URL canon" section in `AGENTS.md` documenting the `staging-<name>.filter.fun` pattern for preview / staging instances (e.g., `staging-arena.filter.fun`, `staging-api.filter.fun`) and the constraint: never reference these in user-facing strings (README, web metadata, env example defaults, OG tags, runbooks). Staging URLs belong in deployment configs and oncall-only docs.

**Severity:** Low
**Files:** AGENTS.md:8-32
**Spec ref:** n/a

**Description:** Locks filter.fun / docs.filter.fun / api.filter.fun. Doesn't address preview deployments.

**Recommendation:** Add a sentence: "Preview/staging instances may use `staging-<name>.filter.fun` but never reference these in user-facing strings (README, OG, canonical)."

**Effort:** XS

---

## INFO

### [Docs] NatSpec coverage on contracts is patchy
**Status:** ↩ **CLOSE-INCIDENTAL** in `audit/polish-docs` (Polish 8 — Audit I-Docs-1). Already addressed by the contracts polish series — see `audit/2026-05-PHASE-1-AUDIT/contracts.md` for the per-contract NatSpec dispositions Polish 1 closed out. Tracking it in this audit was a cross-reference, not a separate finding. No code change in this PR.

**Severity:** Info
**Files:** packages/contracts/src/*.sol (per Contracts audit High finding on BonusDistributor)
**Spec ref:** n/a

**Description:** Several public functions (notably BonusDistributor) lack NatSpec. Tracked in contracts.md.

---

TOTAL: Critical=0 High=2 Medium=3 Low=1 Info=1
