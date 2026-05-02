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
**Severity:** Medium
**Files:** docs/runbook-operator.md:20-38
**Spec ref:** §3.2

**Description:** Cadence table is deterministic (hours 0/48/96/168). No tolerance window: when should an operator escalate if the cut is late?

**Recommendation:** Add a paragraph: "The hard cut should fire within ±2 minutes of the scheduled hour. >5 min late → escalate. Do not manually fire while waiting."

**Effort:** S

### [Docs] zombie-tokens.md not linked from README
**Severity:** Medium
**Files:** README.md (no link to zombie-tokens.md)
**Spec ref:** n/a

**Description:** zombie-tokens.md is comprehensive but not surfaced in the docs index. New operators may not know filtered tokens remain tradable on Uniswap.

**Recommendation:** Add a one-line ref under Operator runbooks in README.

**Effort:** XS

### [Docs] README doesn't note Sepolia redeploy status post-Epic 1.13
**Severity:** Medium
**Files:** README.md:52
**Spec ref:** n/a

**Description:** Clarify whether the bag-lock contracts are already on Sepolia, and link to deployment manifest.

**Recommendation:** Add: "Sepolia redeployed 2026-05-01 with Epic 1.13 contracts; addresses in `packages/contracts/deployments/base-sepolia.json`."

**Effort:** S

---

## LOW

### [Docs] AGENTS.md URL canon doesn't mention staging/preview pattern
**Severity:** Low
**Files:** AGENTS.md:8-32
**Spec ref:** n/a

**Description:** Locks filter.fun / docs.filter.fun / api.filter.fun. Doesn't address preview deployments.

**Recommendation:** Add a sentence: "Preview/staging instances may use `staging-<name>.filter.fun` but never reference these in user-facing strings (README, OG, canonical)."

**Effort:** XS

---

## INFO

### [Docs] NatSpec coverage on contracts is patchy
**Severity:** Info
**Files:** packages/contracts/src/*.sol (per Contracts audit High finding on BonusDistributor)
**Spec ref:** n/a

**Description:** Several public functions (notably BonusDistributor) lack NatSpec. Tracked in contracts.md.

---

TOTAL: Critical=0 High=2 Medium=3 Low=1 Info=1
