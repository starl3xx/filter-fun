# Dependency Audit
**Audit Date:** 2026-05-01

---

## CRITICAL
None.

## HIGH

### [Deps] viem pinned with `^` allowing risky minor bumps
**Status:** 📋 **DOC** in `audit/polish-deps` (Polish 7 — Audit M-Deps-1). Pin-tightening rejected per POLISH_PLAN.md (monorepo policy is to take security patches automatically); the durable mitigation is a documented "any viem upgrade requires a cross-package smoke test" policy. A "Dependency policy" section was added to the root `README.md` enumerating the surfaces that must be smoke-tested (indexer Ponder block-watch, scheduler tx-send + receipt path, oracle merkle build, web wagmi config + Arena read paths) and the fallback action if a release regresses. The audit row here is the audit anchor; the README paragraph is the durable runtime policy.

**Severity:** High → Medium
**Files:** packages/{web,oracle,scheduler,indexer}/package.json
**Spec ref:** n/a

**Description:** All packages pin `"viem": "^2.21.0"`. Caret allows 2.21 → 2.99. viem 2.x has historically introduced breaking changes within minors (chain definitions, RPC signatures). A future install could pull a viem that breaks Uniswap V4 hook interfaces or wagmi compatibility.

**Recommendation:** Either pin exact (`"viem": "2.21.x"`) or narrow (`">=2.21 <2.23"`). At minimum add a doc note: "viem upgrades require full cross-package smoke test."

**Effort:** S

---

## MEDIUM

### [Deps] No TypeScript dep in root package.json
**Status:** 📋 **DOC** in `audit/polish-deps` (Polish 7 — Audit M-Deps-2). Adding TypeScript at the root was rejected — the per-workspace pin keeps each package's TS version + `compilerOptions` self-contained, which matters because the Next.js (`web`), Ponder (`indexer`), and pure-Node (`oracle` / `scheduler` / `scoring`) packages each track different `tsconfig` baselines. A "Typecheck note" callout was added to the README's "Build & dev" section explaining that `tsc` from the repo root will error and that the canonical form is `npm --workspace @filter-fun/<pkg> run typecheck`.

**Severity:** Medium → Low
**Files:** package.json (root)
**Spec ref:** n/a

**Description:** Each workspace pins `"typescript": "^5.5.0"` consistently. Root has none — `tsc` from root errors. Acceptable monorepo pattern but a gotcha for new contributors.

**Recommendation:** Add typescript to root devDependencies, OR add a README note: "Run `npm --workspace @filter-fun/<pkg> run typecheck`."

**Effort:** XS

### [Deps] No `next/image` usage despite available token-avatar surfaces
**Status:** 🚧 **DEFER** in `audit/polish-deps` (Polish 7 — Audit M-Deps-3). Tracked as a performance row instead — `audit/2026-05-PHASE-1-AUDIT/performance.md` already carries the same finding and the Polish 9 (Performance) PR will resolve it there to avoid double-counting. No code change in this PR.

**Severity:** Medium
**Files:** packages/web/src (no next/image imports)
**Spec ref:** n/a

**Description:** Bare `<img>` tags miss Next.js optimisations.

**Recommendation:** Convert above-the-fold avatars/logos to `next/image` with `priority`. (Also tracked in performance.md.)

**Effort:** M

### [Deps] React Query stale-time defaults — admin pages over-refetch
**Status:** 🚧 **DEFER** in `audit/polish-deps` (Polish 7 — Audit M-Deps-4). Tracked as a performance row instead — `audit/2026-05-PHASE-1-AUDIT/performance.md` already carries the same finding and the Polish 9 (Performance) PR will resolve it there to avoid double-counting. No code change in this PR.

**Severity:** Medium → Low
**Files:** packages/web/src/hooks/token/*.ts
**Spec ref:** n/a

**Description:** Wagmi v2 + react-query v5 default `staleTime: 0` causes admin pages to refetch constantly.

**Recommendation:** Set `staleTime: 30_000` for admin/claim hooks; keep 0 for arena live data. (Also tracked in performance.md.)

**Effort:** S

---

## LOW

### [Deps] viem/wagmi not declared as peerDependencies in oracle / scheduler / scoring
**Status:** 🚧 **DEFER** in `audit/polish-deps` (Polish 7 — Audit L-Deps-1). Only matters if any of these packages get published externally. None of `@filter-fun/oracle`, `@filter-fun/scheduler`, or `@filter-fun/scoring` are slated for npm publication — they're internal monorepo packages consumed via workspace links. Re-open this row only if external publication enters scope.

**Severity:** Low
**Files:** packages/{oracle,scheduler,scoring}/package.json
**Spec ref:** n/a

**Description:** Inside the monorepo, hoisting hides this; if any package were ever published to npm, they'd break.

**Recommendation:** Add peerDeps if/when publishing externally.

**Effort:** XS (future)

### [Deps] forge-std / openzeppelin / solady tracked via git submodule, not foundry.toml
**Status:** 📋 **DOC** in `audit/polish-deps` (Polish 7 — Audit L-Deps-2). The submodule pattern is the standard Foundry default and the commit hash IS the version — no code change needed, but a short note was added to `AGENTS.md` under a new "Solidity dependencies" section explaining the pattern and warning against moving these to a `[dependencies]` block in `foundry.toml` without a specific reason (the submodule form survives offline checkouts and has no network-fetched cache to invalidate).

**Severity:** Low
**Files:** packages/contracts/foundry.toml, .gitmodules
**Spec ref:** n/a

**Description:** Standard pattern; commit hash IS the version. Not explicit in foundry config.

**Recommendation:** No action; document in AGENTS.md if needed.

**Effort:** XS (doc only)

### [Deps] Vitest pinned per workspace; no root pin
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-deps` (Polish 7 — Audit L-Deps-3). Re-inspection confirms all TypeScript workspaces pin Vitest at `^2.0.0` consistently. No root-level test command exists or is planned, so no root pin is needed. No code change.

**Severity:** Low
**Files:** packages/*/package.json
**Spec ref:** n/a

**Description:** All ^2.0.0; consistent.

**Recommendation:** No action unless adding root-level test command.

**Effort:** XS

---

## INFO

### [Deps] Solidity locked to 0.8.26 in foundry.toml (PASS)
**Status:** 🔍 **CLOSE-AS-PASS** in `audit/polish-deps` (Polish 7 — Audit I-Deps-1). Re-inspection confirms `packages/contracts/foundry.toml` still pins `solc_version = "0.8.26"` exactly. No code change.

**Severity:** Info
**Files:** packages/contracts/foundry.toml:7

Explicit pin; good.

---

TOTAL: Critical=0 High=1 Medium=3 Low=3 Info=1
