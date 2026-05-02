# Dependency Audit
**Audit Date:** 2026-05-01

---

## CRITICAL
None.

## HIGH

### [Deps] viem pinned with `^` allowing risky minor bumps
**Severity:** High → Medium
**Files:** packages/{web,oracle,scheduler,indexer}/package.json
**Spec ref:** n/a

**Description:** All packages pin `"viem": "^2.21.0"`. Caret allows 2.21 → 2.99. viem 2.x has historically introduced breaking changes within minors (chain definitions, RPC signatures). A future install could pull a viem that breaks Uniswap V4 hook interfaces or wagmi compatibility.

**Recommendation:** Either pin exact (`"viem": "2.21.x"`) or narrow (`">=2.21 <2.23"`). At minimum add a doc note: "viem upgrades require full cross-package smoke test."

**Effort:** S

---

## MEDIUM

### [Deps] No TypeScript dep in root package.json
**Severity:** Medium → Low
**Files:** package.json (root)
**Spec ref:** n/a

**Description:** Each workspace pins `"typescript": "^5.5.0"` consistently. Root has none — `tsc` from root errors. Acceptable monorepo pattern but a gotcha for new contributors.

**Recommendation:** Add typescript to root devDependencies, OR add a README note: "Run `npm --workspace @filter-fun/<pkg> run typecheck`."

**Effort:** XS

### [Deps] No `next/image` usage despite available token-avatar surfaces
**Severity:** Medium
**Files:** packages/web/src (no next/image imports)
**Spec ref:** n/a

**Description:** Bare `<img>` tags miss Next.js optimisations.

**Recommendation:** Convert above-the-fold avatars/logos to `next/image` with `priority`. (Also tracked in performance.md.)

**Effort:** M

### [Deps] React Query stale-time defaults — admin pages over-refetch
**Severity:** Medium → Low
**Files:** packages/web/src/hooks/token/*.ts
**Spec ref:** n/a

**Description:** Wagmi v2 + react-query v5 default `staleTime: 0` causes admin pages to refetch constantly.

**Recommendation:** Set `staleTime: 30_000` for admin/claim hooks; keep 0 for arena live data. (Also tracked in performance.md.)

**Effort:** S

---

## LOW

### [Deps] viem/wagmi not declared as peerDependencies in oracle / scheduler / scoring
**Severity:** Low
**Files:** packages/{oracle,scheduler,scoring}/package.json
**Spec ref:** n/a

**Description:** Inside the monorepo, hoisting hides this; if any package were ever published to npm, they'd break.

**Recommendation:** Add peerDeps if/when publishing externally.

**Effort:** XS (future)

### [Deps] forge-std / openzeppelin / solady tracked via git submodule, not foundry.toml
**Severity:** Low
**Files:** packages/contracts/foundry.toml, .gitmodules
**Spec ref:** n/a

**Description:** Standard pattern; commit hash IS the version. Not explicit in foundry config.

**Recommendation:** No action; document in AGENTS.md if needed.

**Effort:** XS (doc only)

### [Deps] Vitest pinned per workspace; no root pin
**Severity:** Low
**Files:** packages/*/package.json
**Spec ref:** n/a

**Description:** All ^2.0.0; consistent.

**Recommendation:** No action unless adding root-level test command.

**Effort:** XS

---

## INFO

### [Deps] Solidity locked to 0.8.26 in foundry.toml (PASS)
**Severity:** Info
**Files:** packages/contracts/foundry.toml:7

Explicit pin; good.

---

TOTAL: Critical=0 High=1 Medium=3 Low=3 Info=1
