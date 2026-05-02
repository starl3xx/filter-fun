# Phase 1 Audit — 2026-05-01

Scope: end-of-Phase-1 internal review across contracts, indexer, web (general + Arena), UX flows, brand-kit adherence, ▼ vs 🔻 glyph use, accessibility, performance, frontend security, documentation, and dependencies.

This PR ships the **report only** — no behaviour-changing code is included. Findings are documented; remediation happens in follow-up PRs sized appropriately to severity.

## Remediation log

| Finding | Severity | Status | PR |
|---|---|---|---|
| C-1: BonusDistributor missing `nonReentrant` on `fundBonus` / `postRoot` (extended to `claim`) | Critical | ✅ Fixed | audit-remediation PR (BonusDistributor reentrancy + invariant suite extension) |
| C-2: `FilterLauncher.maxLaunchesPerWallet` default = `2` contradicts spec §4.6 lock (= `1`) | Critical | ✅ Fixed | audit-remediation PR (introduce `SPEC_LOCK_MAX_LAUNCHES_PER_WALLET` constant + reproduction test) |
| C-3: `/tokens/:address/history` cache wired to `tokensTtlMs` (5s) instead of `profileTtlMs` (~5min intent) — 60× under-cache | Critical | ✅ Fixed | audit-remediation PR (one-line middleware wiring fix + TTL-introspection regression test) |
| C-4: `/tokens/:address/holders` endpoint missing | Critical | ✅ Deferred to Phase 2 | audit-remediation PR (explicit deferral documented in indexer README + route docstring + Phase-2 design constraints) |
| C-5: No error boundary on `/` or `/launch` (homepage + launch page crash silently on hook errors) | Critical | ✅ Fixed | audit-remediation PR (Next.js `error.tsx` boundaries + inline `DataErrorBanner` for soft fetch errors) |
| C-6: Claim pages issue `writeContract` with no chain / balance preflight | Critical | ✅ Fixed | audit-remediation PR (extracted pure `computeClaimPreflight` policy + `useSwitchChain` CTA + 6-case unit test) |
| C-7: Admin console's center column blanks silently when hooks error | Critical | ✅ Fixed | audit-remediation PR (coalesce 4 hook errors → `LiveDataErrorCard` in center column) |
| C-8: Bricolage Grotesque weights 500 + 600 not loaded (ARENA_SPEC §2.1/§2.2 mandates 5 weights) | Critical | ✅ Fixed | audit-remediation PR (one-line font weight array fix + NatSpec regression note) |
| H-1: Insufficient NatSpec on `BonusDistributor` `fundBonus`/`postRoot`/`claim` | High | ✅ Fixed | `audit/contracts-high-batch-1` (full `@notice` + per-parameter docs + grep-based `BonusDistributorNatSpec.t.sol` regression test) |
| H-2: `SeasonVault` stores its own `oracle`; launcher rotation leaves prior vaults honouring stale oracle (spec §42.2.6) | High | ✅ Fixed | `audit/contracts-high-batch-1` (live-read via `ILauncherView.oracle()`; stored field dropped + ctor param removed; `SeasonVaultOracleStaleness.t.sol` deterministic suite + `invariant_oracleAuthorityCurrent` settlement-suite extension with `fuzz_rotateLauncherOracle`) |
| H-3: `BonusDistributor.setOracle` mis-named revert (`NotOracle` for a launcher-only gate) | High | ✅ Fixed | `audit/contracts-high-batch-1` (`error NotLauncher` + `onlyLauncher` modifier; `BonusDistributorSetOracleNaming.t.sol`) |
| H-4: `FilterLauncher` admin setters + constructor accept `address(0)` | High | ✅ Fixed | `audit/contracts-high-batch-1` (zero-address checks added to `setOracle`/`setFactory`; `setPolManager` normalised from string-`require` to `revert ZeroAddress`; constructor address params validated; `AdminSetterZeroAddressChecks.t.sol`) |
| Indexer H-1: V4 placeholder values masquerade as real data (`price`/`volume24h`/`liquidity`/`holders` = `0`) | High | ✅ Fixed | `audit/indexer-high-batch-2` (placeholder fields → `null`; new `dataAvailability` block on TokenRow; `tokenRowPlaceholderHonesty.test.ts`) |
| Indexer H-2: inconsistent error semantics across endpoints (`/season` 404 vs `/tokens` 200/empty) | High | ✅ Fixed | `audit/indexer-high-batch-2` (`/season` → `200 + {status: "not-ready", season: null}`; convention pinned in handlers.ts + README; `endpointStatusContract.test.ts`) |
| Indexer H-3: 5× `as unknown as MwContext` casts disable type safety on Ponder Context | High | ✅ Fixed | `audit/indexer-high-batch-2` (`toMwContext(c)` adapter with runtime shape assertion + named-field error messages; 7 cast sites replaced; `mwContextAdapter.test.ts`) |
| Indexer H-4: no readiness probe beyond Ponder's liveness `/health` | High | ✅ Fixed | `audit/indexer-high-batch-2` (`GET /readiness` returns 200 only when latest-season indexed AND tick engine running, 503 otherwise; `TickEngine.isRunning()`; `readinessProbe.test.ts`) |
| Indexer H-5: holder snapshot `trigger` label not validated against spec §42 cadence (CUT @ h96, FINALIZE @ h168) | High | ✅ Fixed | `audit/indexer-high-batch-2` (`validateSnapshotCadence` + structured warn-log on >5min drift; wired into `holderBadgeFlagsForUser`; `snapshotCadenceDrift.test.ts`) |
| Indexer H-6: no CORS middleware — browser clients on filter.fun + docs subdomain blocked in production | High | ✅ Fixed | `audit/indexer-high-batch-2` (`hono/cors` mounted on every route via `ponder.use("*")`; pure `originAllowed` policy; env override `CORS_ALLOWED_ORIGINS`; `corsAllowedOrigins.test.ts`) |
| Arena H-1: TICKER_COLORS drifts from ARENA_SPEC §3.2 (11/12 wrong hex values) | High | ✅ Fixed | `audit/arena-high-batch-4` (spec-exact 12-entry map; `tickerColor()` falls back to `C.purple`; `tickerColorsMap.test.ts`) |
| Arena H-2: HpBar fills by HP value instead of ARENA_SPEC §6.4.3 status gradient | High | ✅ Fixed | `audit/arena-high-batch-4` (`STATUS_GRADIENT` map keyed by `TokenStatus`; `status` prop threaded through `ArenaLeaderboard`; HP-bucket colour kept as fallback only; `hpBarStatusGradient.test.ts`) |
| Arena H-3: AT_RISK status badge uses orange ⚠️ instead of red ▼ | High | ✅ Fixed | `audit/arena-high-batch-4` (`{color: C.red, label: "At risk", icon: "▼"}`; pinned to U+25BC, NOT 🔻 emoji; `statusBadgeAtRisk.test.tsx`) |
| Arena H-4: HP breakdown uses single cyan→pink gradient (should be per-component) | High | ✅ Fixed | `audit/arena-high-batch-4` (`HP_COMPONENT_COLORS` in `hpLabels.ts`: Velocity pink / Buyers cyan / Liquidity yellow / Retention green / Momentum purple; applied to both label colour and bar gradient — combines with M-Arena "labels in dim" finding; `hpComponentColors.test.ts`) |
| Arena H-5: LIVE pill `padding: 3px 10px` / bg 10% / border 33% (spec: 5×11 / 12% / 40%) | High → Medium | ✅ Fixed | `audit/arena-high-batch-4` (Pill component padding 5px 11px / `${color}1f` bg / `${color}66` border; `arenaTopBarSpec.test.tsx`) |
| Arena H-6: Top-bar wordmark renders all-white (`.fun` should be pink) | High | ✅ Fixed | `audit/arena-high-batch-4` (Brand split into `<span color: C.text>filter</span><span color: C.pink>.fun</span>`; `arenaTopBarSpec.test.tsx`) |
| Arena M-1: JetBrains Mono loaded 500/700/800 (spec: 400/500/600/700) | Medium | ✅ Fixed | `audit/arena-high-batch-4` (`weight: ["400","500","600","700"]` in `app/layout.tsx`; NatSpec regression note mirrors C-8's pattern; `jetbrainsMonoWeights.test.ts`) |
| A11y H-1: Form inputs set `outline: "none"` without `:focus-visible` replacement (WCAG 2.4.7) | High | ✅ Fixed | `audit/a11y-high-batch-5` (single shared `input/textarea/select:focus-visible` rule in `globals.css` with `outline: 2px solid var(--cyan) !important`; `!important` required because inline `outline: none` on each form outranks pseudo-class rules in the cascade; `formFocusVisible.test.tsx` reads `globals.css` and pins the outline + offset, plus a render-side guard that LaunchForm's inline `outline: none` reset survives) |
| A11y H-2: SAFE status pill `icon: null` violates ARENA_SPEC §12 icon+colour rule | High | ✅ Fixed | `audit/a11y-high-batch-5` (`icon: "✓"` U+2713; `treatmentFor()` return type tightened to `icon: string`; rendering site changed from conditional `{icon ? <span>…</span> : null}` to unconditional `<span aria-hidden>{icon}</span>` so future statuses can't reintroduce the bug; `statusBadgeIconContract.test.tsx` pins the four-status icon contract + the always-render-span structural rule; arena snapshot updated) |

---

## Executive summary

### Totals by severity

| Severity | Count |
|---|---|
| Critical | **8** |
| High | **29** |
| Medium | **53** |
| Low | **30** |
| Info | **25** |
| **TOTAL** | **~145** |

(High count includes one ambiguous finding around 🔻 ticker payload — see Appendix B.)

### Top 5 most-impactful findings

1. **Contracts §Critical — `BonusDistributor.fundBonus()` and `postRoot()` lack `nonReentrant`.** Spec §42 invariant 5 requires every settlement-pipeline function to be reentrancy-safe. Both functions mutate state and one transfers WETH via `safeTransferFrom`. Must fix before mainnet. → `Findings → Contracts → Critical #1`
2. **Contracts §Critical — `maxLaunchesPerWallet` default = 2, spec §4.6 locks it to 1.** Default lives in code; deploy-script overrides via env var. If env var is missing or the override fails, mainnet ships with the wrong cap. → `Findings → Contracts → Critical #2`
3. **Indexer §Critical — `/tokens/:address/history` cache uses `tokensTtlMs` (5s) instead of intended `profileTtlMs` / 5min.** 60× under-cache; thrashes upstream under any repeated request pattern. Trivial one-line fix. → `Findings → Indexer → Critical #2`
4. **Web §Critical — no error boundaries on `/` or `/launch`.** A failing `/season` or `/tokens` call crashes the component tree silently. Users see a blank page or a partially rendered shell. → `Findings → Web (general) → Critical #1`
5. **Web §Critical — claim pages have no balance / wrong-network preflight.** Users sign claim transactions and discover ineligibility only when the contract reverts. Combined with the lack of friendly proof-error mapping (UX flow 5), this is the highest-friction part of the post-filter user journey. → `Findings → Web (general) → Critical #2`

### Phase-2 readiness assessment

Phase 1 is structurally sound. The 8 Critical findings cluster into three remediation themes: (a) settlement-invariant strengthening on `BonusDistributor` and `TournamentVault`, (b) restoring the `maxLaunchesPerWallet=1` lock at the contract level rather than the deploy script, and (c) making the web app fail visibly rather than silently when the indexer or RPC misbehaves. None of the eight blocks Phase 2 entry on their own; together they represent ~3 days of focused work. The audit-prep invariant suite (PR #50) and the Sepolia operational verification (PR #46) provide the test scaffolding to land the contract fixes safely. Recommend ordering remediation by blast radius: contracts first (because mainnet deploy is the gate), then indexer cache + missing endpoint, then web error-handling.

### Recommended remediation order

1. **Contracts Critical** — both findings together (one PR; small surface; tests exist).
2. **Contracts High** — SeasonVault oracle staleness, BonusDistributor `setOracle` naming, missing zero-address checks. Land before mainnet deploy.
3. **Indexer Critical** — cache TTL fix (one-line) + `/tokens/:address/holders` decision (defer with explicit ROADMAP note OR ship endpoint).
4. **Web Critical** — error boundaries + claim-page preflight checks + admin-page error UI. One PR per page is fine.
5. **Arena High** (TICKER_COLORS map, HpBar gradient logic, AT_RISK icon, HP-breakdown colours, LIVE pill, wordmark `.fun` pink, JetBrains Mono weights, Bricolage Grotesque weights). Group as a single "ARENA_SPEC §3 + §6.1 + §6.4 + §6.5 fidelity pass" PR.
6. **A11y High** — focus-visible replacement + SAFE status icon. Small PR.
7. **Mediums in batches by area** (web-general / arena / indexer / contracts / docs / deps / a11y / perf / security).
8. **Lows + Infos** — backlog or "polish week".

---

## Findings by category

The detailed per-category finding lists live as siblings to this file (one MD per area) so this index stays scannable. The links below cover everything.

### Contracts
See `audit/2026-05-PHASE-1-AUDIT/contracts.md` (Critical 2, High 4, Medium 5, Low 4, Info 5)

Headline items:
- `BonusDistributor.fundBonus` / `postRoot` missing `nonReentrant` (Critical)
- `FilterLauncher.maxLaunchesPerWallet = 2` default (Critical, spec §4.6 locks 1)
- `SeasonVault.oracle` may stale if launcher rotates oracle mid-season (High)
- `BonusDistributor.setOracle` correct gate but misleading error name (`NotOracle` vs `NotLauncher`) (High)
- `TournamentVault.claimRollover` / `claimBonus` lack `nonReentrant` despite class inheriting `ReentrancyGuard` (Medium)
- §42 invariants 7 and 8 (no mid-season POL, dust handling) — verify explicit test coverage (Info)

### Indexer
See `audit/2026-05-PHASE-1-AUDIT/indexer.md` (Critical 2, High 6, Medium 6, Low 4, Info 4)

Headline items:
- `/tokens/:address/history` cache uses 5s TTL not 5min (Critical, 1-line fix)
- No `/tokens/:address/holders` endpoint despite spec §41.3 / §22 implications (Critical → may be intentional deferral; document)
- 404 vs 200/empty inconsistency across `/season` / `/tokens` / `/profile` (High)
- `as unknown as MwContext` cast pattern at 5 sites disables type-checking (High)
- No CORS middleware (High; if web is on a different origin)
- Holder snapshot timing not validated against expected hour-96 / hour-168 cadence (High)
- No `/readiness` distinct from Ponder's `/health` (High)
- `console.error` in tick loop without structured logging (Medium)

### Web (general)
See `audit/2026-05-PHASE-1-AUDIT/web-general.md` (Critical 3, High 5, Medium 9, Low 1, Info 3)

Headline items:
- No error boundary on `/` or `/launch` (Critical)
- Claim pages skip wallet-balance / wrong-network preflight (Critical)
- Admin console silently fails on RPC error — no error UI (Critical)
- Wagmi config supports only `injected()` — no Coinbase Wallet, no WalletConnect (High)
- Stale-closure mitigation in LaunchForm reads live cost via ref — clarify lock-at-submit intent (High)
- ClaimForm proof array under-validated (length, hex format) (High)
- Admin pendingAdmin zero-address check duplicated; should normalise in hook (High)
- No useEffect to scroll-to-accept when admin auth state mounts as PENDING (High)

### Web — Arena page (ARENA_SPEC.md compliance)
See `audit/2026-05-PHASE-1-AUDIT/arena.md` (Critical 1, High 6, Medium 8, Low 6, Info 5)
See also `audit/2026-05-PHASE-1-AUDIT/arena-spec-checklist.md` (full §14 walkthrough)

Headline items:
- Bricolage Grotesque weights 500 + 600 not loaded (Critical)
- TICKER_COLORS map drifts from §3.2 (11/12 entries wrong) (High)
- HpBar uses single 4-colour spectrum — should be status-driven gradient per §6.4.3 (High)
- AT_RISK status badge uses orange ⚠️ instead of red ▼ (High)
- HP breakdown bars share single gradient — should be per-component colour per §6.5.3 (High)
- Top-bar wordmark renders all-white — `.fun` should be pink per §6.1 (High)
- LIVE pill padding/border alpha drift from §6.1 (High → Medium)
- Leaderboard column grid widths drift from §6.4.2 (Medium)
- Activity feed has no event-type → icon/colour map per §6.6 (Medium)
- Responsive grid replaces fixed 1440×980 — intentional per project memory; document (Medium, design decision)

### UX flows
See `audit/2026-05-PHASE-1-AUDIT/ux-flows.md` (Critical 0, High 0-1, Medium 8, Low 4, Info 0)

Headline items:
- Flow 1: no prominent Connect-wallet CTA on the homepage (Medium)
- Flow 2: no in-app trade panel found in ArenaTokenDetail — confirm Phase 1 scope (High → Medium)
- Flow 4: admin loading + tx-pending states not surfaced consistently (Medium ×2)
- Flow 5: Merkle proof failure surfaced as raw EVM error (Medium)
- Flow 6: bonus eligibility ≠ claim status — UI conflates (Medium)
- Flow 7: slow-network FILTER_FIRED arrival — no fallback if event >10s late (Low)

### Brand kit adherence
See `audit/2026-05-PHASE-1-AUDIT/brand.md` (Critical 0, High 0, Medium 3, Low 2, Info 2)

Headline items:
- Bricolage Grotesque weight 900 used at 15+ sites but not loaded (Medium)
- Multiple pulse cadences (1.4s / 1.2s / 2.4s) — clarify spec scope (Medium)
- Wordmark SVG ships in brand kit but no React `<Wordmark>` component (Medium)
- Palette + locked tagline both PASS (Info)

### Spec drift
Aggregated from category audits; no separate file. Drift hot-spots:
- `maxLaunchesPerWallet` default (Contracts Critical)
- TICKER_COLORS map (Arena High)
- LIVE pill / wordmark / leaderboard grid widths (Arena High/Medium)
- `bag-lock` pre-1.13 caveat not surfaced in operator runbook (Docs High)

### Test coverage gaps
- Contracts: §42 invariants 7 + 8 verification needed; BonusDistributor `claim()` happy + revert + edge tests inferred but not confirmed
- Indexer: `/token/:address` handler has no tests; `/tokens/:address/history` edge cases not exercised
- Web: ClaimForm Merkle-failure path not tested; admin two-step transfer state machine not covered

### Documentation
See `audit/2026-05-PHASE-1-AUDIT/docs.md` (Critical 0, High 2, Medium 3, Low 1, Info 1)

Headline items:
- `runbook-operator.md` doesn't cross-reference the bag-lock pre-1.13 caveat (High; operator hazard)
- `runbook-sepolia-smoke.md` gas figure may be stale post-Epic 1.13 (High)
- `runbook-operator.md` cadence table has no drift tolerance (Medium)
- `zombie-tokens.md` not linked from README (Medium)
- README doesn't note Sepolia redeploy status post-Epic 1.13 (Medium)

### Accessibility
See `audit/2026-05-PHASE-1-AUDIT/a11y.md` (Critical 0, High 2, Medium 2, Low 2, Info 1)

Headline items:
- Form inputs `outline: "none"` without focus-visible replacement (High; WCAG 2.4.7)
- SAFE status pill has `icon: null` — violates ARENA_SPEC §12 icon+colour rule (High)
- Checkbox label nesting without explicit htmlFor (Medium)

### Performance
See `audit/2026-05-PHASE-1-AUDIT/performance.md` (Critical 0, High 2, Medium 3, Low 1, Info 1)

Headline items:
- No CSP / security headers in next.config.mjs (High)
- SSE `useTickerEvents` factoryRef dependency stability (High → Medium)
- Bundle includes full wagmi/chains (Medium)
- React Query staleTime defaults — admin pages over-refetch (Medium)
- No `next/image` usage despite token-avatar surfaces (Medium)

### Security (frontend)
See `audit/2026-05-PHASE-1-AUDIT/security.md` (Critical 0, High 1, Medium 3, Low 2, Info 1)

Headline items:
- No Content-Security-Policy headers (High)
- PINATA_JWT correctly server-only — no leak detected (Info; PASS)
- Image URL validated as HTTPS-only but no redirect / data-URI check (Medium)
- Form validation client-side only — confirm server re-validation (Medium)
- No `dangerouslySetInnerHTML` anywhere (Info; PASS)

### Triangle glyph (▼ vs 🔻)
See `audit/2026-05-PHASE-1-AUDIT/triangle-glyph-audit.md` and Appendix B below.

Headline:
- ▼ usage everywhere correct
- 🔻 occurrences are 4 wire-payload sites (intentional per-design comments) + 5 internal comments + 1 doc example + 1 test fixture
- **Latent risk:** `ArenaTicker.tsx` renders `headline.message` *verbatim*; if the indexer payload contains 🔻, the user sees 🔻. May be intentional ticker-payload semantics OR a mis-aligned override depending on interpretation. Flagged as 1 High finding pending interpretation lock-in.

### Dependencies
See `audit/2026-05-PHASE-1-AUDIT/deps.md` (Critical 0, High 1, Medium 3, Low 3, Info 1)

Headline items:
- viem pinned with `^` allowing risky minor bumps (High → Medium)
- No TypeScript dep in root package.json (Medium → Low)
- React Query stale-time defaults (Medium → Low; cross-listed with performance)

---

## Appendix A: ARENA_SPEC §14 QA checklist

Full per-item verdicts in `audit/2026-05-PHASE-1-AUDIT/arena-spec-checklist.md`. Summary:

| Status | Count |
|---|---|
| PASS | 11 |
| PARTIAL | 6 |
| FAIL | 7 |
| UNKNOWN | 1 (BUY/SELL CTA — trade panel scope unclear) |

Top FAILs:
- Leaderboard grid widths (#6)
- TICKER_COLORS avatar colours (#8)
- HP bar status-driven gradient (#9)
- HP breakdown component-specific colours (#12)
- Activity feed icons + colours (#14)
- Wordmark `.fun` pink (#2)
- Ranks 11-12 opacity 0.5 (sub-item under §3.3)

---

## Appendix B: ▼ vs 🔻 audit

Full per-occurrence table in `audit/2026-05-PHASE-1-AUDIT/triangle-glyph-audit.md`. Summary:

- **Total occurrences:** ~44 (12 × 🔻, ~32 × ▼)
- **▼:** PASS at every user-facing site; rendered via `<Triangle>` SVG (gradient pink #ff5fb8 → red #ff2d55) or as the literal Unicode glyph
- **🔻:** classified as
  - 4 × wire-payload-by-design (`packages/indexer/src/api/events/message.ts:66, 89, 92` + ticker config)
  - 5 × internal comments documenting the wire-payload intent
  - 1 × test fixture (`packages/web/test/arena/Ticker.test.tsx`) intentionally mirrors wire payload
  - 1 × doc example (`packages/indexer/README.md`)
  - 1 × downstream render-through path (`ArenaTicker.tsx` displays `headline.message` verbatim — may render 🔻 to the user depending on payload)

**Open question (1 High finding contingent on interpretation):**
The "every 🔻 in user-visible UI is a FAIL" rule, applied strictly, makes the wire-payload approach a problem because the ticker renders the message string unchanged. Either (a) update AGENTS.md / spec §32.4 to scope the override to *brand-mark* surfaces only, leaving ticker chips free to use 🔻, or (b) add a render-time swap in `ArenaTicker.tsx` that replaces 🔻 with `<Triangle inline />` (or even a simple Unicode swap to ▼). Recommendation: lock interpretation (a) and document. Effort either way is XS.

---

## Appendix C: dependency / version drift

Full list in `audit/2026-05-PHASE-1-AUDIT/deps.md`. Summary:

- viem pinned `^2.21.0` consistently; caret allows risky minor bumps
- TypeScript pinned `^5.5.0` per workspace, none in root
- React 18.3, Next.js 14.2, wagmi 2.12, vitest 2.0 — consistent across packages
- Foundry: solidity 0.8.26 explicit; forge-std / openzeppelin-contracts / solady tracked via git submodule
- No deprecated packages observed; no `npm audit` red flags surfaced (recommend running before mainnet)
- Suggested action: tighten viem version range OR add a doc note that viem upgrades require cross-package smoke test

---

## Methodology

This audit was conducted on branch `starl3xx/phase-1-audit` (cut from `origin/main` at commit `c516e33`). It dispatched five parallel domain agents, each reading the relevant slice of:

- the comprehensive spec (`filter_fun_comprehensive_spec.md`, 3 538 lines, 43 sections)
- the roadmap (`ROADMAP.md`, 881 lines)
- the Arena visual spec (`ARENA_SPEC.md`, 848 lines, 14 sections)
- the locked brand kit (`filter.fun-brand-kit/` — palette, tokens, marks)
- AGENTS.md, README.md, docs/

(Spec / roadmap / brand-kit live outside this repo in the operator's design vault; they are not redistributed here. The references above are by name, not path.)

Findings were aggregated under uniform severity rubric (Critical / High / Medium / Low / Info) and finding template (file:line + spec ref + description + evidence + recommendation + effort). The report is read-only — no behaviour-changing code was modified.

For raw per-area finding files (kept alongside this report so reviewers can drill into individual categories without overflowing the summary), see the `audit/2026-05-PHASE-1-AUDIT/` directory.

---

*End of audit. Findings become the input to follow-up PRs sized appropriately to severity.*
