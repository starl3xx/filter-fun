# Phase-1 Audit — Polish Plan
**Authored:** 2026-05-02 (after Crit + High remediation landed)
**Author branch:** `audit/polish-contracts` (this PR)
**Scope:** All Medium / Low / Info findings remaining across the 11 audit category files
**Cadence:** One PR per audit category. Sequential first (Polish 1 sets the bar), then small parallel batches.

---

## Why this exists

The Critical and High remediation campaign closed every blocking finding. What's
left is the polish layer — Medium correctness/UX issues, Low cosmetic + naming
items, and Info entries that are either documentation tasks, deferred-by-design
notes, or PASS observations to be acknowledged so a future auditor doesn't
re-flag the same line.

This document is the canonical map: every finding has a row, a classification,
a target PR, and a planned disposition. After all polish PRs land, the live
one-pager's "Internal Phase 1 audit" status line flips to "Closed" and the
underlying audit files no longer carry any open `[OPEN]` rows for Phase 1.

## Classification key

| Tag | Meaning |
| --- | --- |
| **CODE** | Source change required. Medium → ships with a regression test; Low → optional test (only if cheap); Info → no test. |
| **DOC** | NatSpec / README / runbook / .env.example / inline comment only. |
| **DEFER** | Acknowledged Phase-2 follow-up. Closed in this pass with a status note + (where applicable) a one-line ROADMAP entry; no code change. |
| **CLOSE-AS-PASS** | Re-inspection confirmed the finding is already correct or non-applicable. Closed with a status note explaining the verdict. |
| **CLOSE-INCIDENTAL** | Already closed by an earlier Critical/High batch. Status note added pointing at the closing PR. |

## Test policy (recap)

- **Medium** — regression test required. Source-grep tests are fine when the cheaper
  semantic test would need a heavy harness (the H-Web pattern). Place under each
  package's existing `test/regression/` (web), `test/api/security/` (indexer), or
  `test/security/` (contracts) directory.
- **Low** — regression test optional. Add one only if it's cheap and obvious. Otherwise
  rely on the type system + the close-out commit message + the PR's findings table.
- **Info** — no test. The audit file's status note IS the regression layer.

---

## PR sequencing

```
Polish 1 — Contracts                           (this PR; sets template + bar)
   ├─→ Polish 2 — Indexer       ┐
   └─→ Polish 3 — Web general   ┘  parallel after #1 lands
        ├─→ Polish 4 — Arena    ┐
        └─→ Polish 5 — A11y     ┘  parallel after #2/#3 land
             ├─→ Polish 6 — Brand
             ├─→ Polish 7 — Deps
             ├─→ Polish 8 — Docs
             ├─→ Polish 9 — Performance
             ├─→ Polish 10 — Security
             └─→ Polish 11 — UX flows           any order, batched
```

Pause between PRs for review/merge before the next branch cuts. Keep PRs scoped
to one audit file each so bugbot can review the bounded surface and the merge
log shows a clean per-file remediation trail.

---

## Polish 1 — Contracts (this PR)

Source: `audit/2026-05-PHASE-1-AUDIT/contracts.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Contracts-1 | Medium | SeasonVault missing event for oracle init | CODE — emit `OracleAssigned` (now redundant since H-2 dropped the stored field; verify) |
| M-Contracts-2 | Medium | FilterLauncher missing `FactorySet` event | CODE — add event + emit |
| M-Contracts-3 | Medium | TournamentVault.claimRollover/claimBonus lack `nonReentrant` | CODE — add modifier on all 4 claim entries |
| M-Contracts-4 | Medium | Creator fee window doc note (eligibility intent) | DOC — NatSpec on `ELIGIBILITY_WINDOW` |
| M-Contracts-5 | Medium | Magic-number constants for fee BPS splits | CLOSE-AS-PASS — the audit's own re-inspection confirms compliance |
| M-Contracts-6 | Medium | Tournament POL deployment deferred | DOC — pin the deferral in NatSpec on `TournamentVault` |
| L-Contracts-1 | Low | FilterLauncher constants lack NatSpec | DOC — `@notice` on `MAX_LAUNCHES`, `LAUNCH_WINDOW_DURATION` |
| L-Contracts-2 | Low | POLVault.setPolManager error style | CLOSE-AS-PASS — re-inspection confirms |
| L-Contracts-3 | Low | CreatorRegistry.acceptAdmin failure event | CLOSE-AS-PASS — revert IS the signal; logging revert paths is anti-pattern |
| I-Contracts-1 | Info | `NotUnlocked` rename for clarity | CODE — rename to `NotYetUnlocked` (single-PR rename, low risk) |
| I-Contracts-2 | Info | `ISeasonPOLReserve` interface | DEFER — Phase-2 follow-up; only used internally today |
| I-Contracts-3 | Info | Verify §42 invariants 7+8 coverage | CODE — verify; add tests if gaps found |
| I-Contracts-4 | Info | POLManager zero-amount check | CLOSE-AS-PASS — already correct |
| I-Contracts-5 | Info | CreatorFeeDistributor design assumption | DOC — NatSpec on `lastSeenBalance` accounting |

**Counts:** 5 Med / 3 Low / 5 Info → **6 CODE / 4 DOC / 1 DEFER / 4 CLOSE-AS-PASS**

---

## Polish 2 — Indexer

Source: `audit/2026-05-PHASE-1-AUDIT/indexer.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Indexer-1 | Medium | TokenRow.creator? optional but not validated | CODE — make required + assert |
| M-Indexer-2 | Medium | Test gap: `/token/:address` handler | CODE — add 3 vitest cases |
| M-Indexer-3 | Medium | Test gap: `/tokens/:address/history` edges | CODE — add `parseInterval`/`parseRange` tests |
| M-Indexer-4 | Medium | SSE `Retry-After: 30` rationale | DOC — comment explaining the rationale |
| M-Indexer-5 | Medium | IP rate-limit collapses unknown to one bucket | CODE — header-hash fallback identifier |
| M-Indexer-6 | Medium | `console.error` in tick.ts unstructured | CODE — switch to structured logger w/ redaction |
| L-Indexer-1 | Low | Profile asymmetric error semantics | DOC — JSDoc on the route |
| L-Indexer-2 | Low | No pagination on `/tokens` | DEFER — wait for >100-token surface (current Phase 1 max = 12) |
| L-Indexer-3 | Low | `unlockTimestamp > nowSec` assumption | DOC — assertion comment |
| L-Indexer-4 | Low | Holder snapshot trigger string-literals | CODE — `HolderSnapshotTrigger` type alias |
| I-Indexer-1 | Info | Known gap: price/volume/liquidity/holders | CLOSE-INCIDENTAL — closed by H-1 in indexer-high-batch-2 |
| I-Indexer-2 | Info | `takenAtSec` capture-time drift | DOC — comment on the read site |
| I-Indexer-3 | Info | No `/api/version` endpoint | DEFER — add at first breaking change |
| I-Indexer-4 | Info | Concentration filtering deferred | DOC — confirm ROADMAP entry |

**Counts:** 6 Med / 4 Low / 4 Info → **6 CODE / 5 DOC / 2 DEFER / 1 CLOSE-INCIDENTAL**

---

## Polish 3 — Web general

Source: `audit/2026-05-PHASE-1-AUDIT/web-general.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Web-1 | Medium | ClaimForm status badge flicker / shift | CODE — fixed-height placeholder |
| M-Web-2 | Medium | LaunchForm submit race re-validation | CODE — re-validate inside handleSubmit |
| M-Web-3 | Medium | No 375px mobile breakpoint | CODE — add @media + ≥44px tap targets |
| M-Web-4 | Medium | Numeric fields not integer-validated on claim | CODE — `Number.isInteger` guard |
| M-Web-5 | Medium | /launch grid collapses below 1100px without context | CODE — inline hint OR move form above slot grid |
| M-Web-6 | Medium | Eligibility loading state has no animation | CODE — apply `ff-pulse` to title |
| M-Web-7 | Medium | Metadata route missing `import "server-only"` | CODE — one-line add |
| M-Web-8 | Medium | Wagmi RPC env vars not validated | CODE — throw at module load if unset for active chain |
| M-Web-9 | Medium | Legacy CSS variable aliases used by ClaimForm | CODE — switch to `@/lib/tokens` |
| L-Web-1 | Low | Dead `walletFilteredTickers` | DEFER — wire when `/wallets/{address}/holdings` ships |
| I-Web-1 | Info | PINATA_JWT correctly server-only | CLOSE-AS-PASS |
| I-Web-2 | Info | Two-step admin transfer correctly gated | CLOSE-AS-PASS |
| I-Web-3 | Info | Ticker-collision check debounced | CLOSE-AS-PASS |

**Counts:** 9 Med / 1 Low / 3 Info → **9 CODE / 0 DOC / 1 DEFER / 3 CLOSE-AS-PASS**

---

## Polish 4 — Arena

Source: `audit/2026-05-PHASE-1-AUDIT/arena.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Arena-1 | Medium | Leaderboard column grid widths drift | CODE — adopt spec or document the responsive variant |
| M-Arena-2 | Medium | Activity feed event-type → icon/colour map | CODE — `EVENT_TYPE_STYLES` map |
| M-Arena-3 | Medium | Activity feed header missing 📡 + STREAMING pill | CODE — add icon + Pill |
| M-Arena-4 | Medium | HP breakdown labels in dim | CLOSE-INCIDENTAL — closed by H-Arena-4 |
| M-Arena-5 | Medium | JetBrains Mono weights | CLOSE-INCIDENTAL — closed by M-Arena-1 in arena-high-batch-4 |
| M-Arena-6 | Medium | Top-bar stat value font size 16 vs spec 14 | CODE — `fontSize: 14` |
| M-Arena-7 | Medium | Responsive grid (Design Decision) | DOC — note in ARENA_SPEC + globals.css |
| M-Arena-8 | Medium | Leaderboard header grid alignment | combined with M-Arena-1 |
| L-Arena-1 | Low | Rows below cut opacity 0.62 vs spec 0.5 | CODE — opacity 0.5 only at 10-11 |
| L-Arena-2 | Low | Cut line badge "5×14" interpretation | DOC — clarify spec, verify in DevTools |
| L-Arena-3 | Low | Leaderboard row missing chevron column | CODE — append chevron span |
| L-Arena-4 | Low | Top bar gap 12 vs spec 22 | CODE — `gap: 22` |
| L-Arena-5 | Low | Top bar padding `12px 18px` vs spec `0 22px` | CODE — update padding + min-height 56 |
| L-Arena-6 | Low | Finalist HP score yellow text-shadow | CLOSE-INCIDENTAL — closed by H-Arena-2 |
| I-Arena-1..5 | Info | All PASS observations | CLOSE-AS-PASS |

**Counts:** 8 Med / 6 Low / 5 Info → **6 CODE / 2 DOC / 0 DEFER / 8 CLOSE (3 INCIDENTAL + 5 PASS)**

---

## Polish 5 — A11y

Source: `audit/2026-05-PHASE-1-AUDIT/a11y.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-A11y-1 | Medium | Checkbox label without explicit htmlFor/id | CODE — explicit pairing |
| M-A11y-2 | Medium | Links inputs use aria-label not visible labels | CODE — wrap in `<label>` w/ visible text |
| L-A11y-1 | Low | aria-live region scope unclear on /launch | CODE — add explicit live region |
| L-A11y-2 | Low | AT_RISK chip continuous pulse | CLOSE-AS-PASS — prefers-reduced-motion respected |
| I-A11y-1 | Info | StatusBadge icon-and-label pattern | CLOSE-AS-PASS |

**Counts:** 2 Med / 2 Low / 1 Info → **3 CODE / 0 DOC / 0 DEFER / 2 CLOSE-AS-PASS**

---

## Polish 6 — Brand

Source: `audit/2026-05-PHASE-1-AUDIT/brand.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Brand-1 | Medium | Bricolage weight 900 used but not loaded | CODE — add `"900"` to weight array |
| M-Brand-2 | Medium | Multiple pulse cadences | DOC — document the intentional cadence split |
| M-Brand-3 | Medium | No React wordmark component | DOC — document text composition is canonical |
| L-Brand-1 | Low | Unused `--ff-grad-mark` CSS var | CODE — refactor Triangle to read it OR delete the var |
| L-Brand-2 | Low | LaunchHero gradient direction differs | DOC — comment intentional extension |
| I-Brand-1..2 | Info | Palette + tagline PASS | CLOSE-AS-PASS |

**Counts:** 3 Med / 2 Low / 2 Info → **2 CODE / 3 DOC / 0 DEFER / 2 CLOSE-AS-PASS**

---

## Polish 7 — Deps

Source: `audit/2026-05-PHASE-1-AUDIT/deps.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Deps-1 | Medium | viem `^` allows risky minor bumps | DOC — README note: viem upgrades require cross-package smoke (pin-tightening rejected: monorepo policy is to take security patches automatically) |
| M-Deps-2 | Medium | No TypeScript dep in root | DOC — README note on workspace tsc invocation |
| M-Deps-3 | Medium | No next/image | DEFER — covered by Polish 9 (Performance), tracked there |
| M-Deps-4 | Medium | React Query staleTime defaults | DEFER — covered by Polish 9 (Performance), tracked there |
| L-Deps-1 | Low | viem/wagmi peerDeps in oracle/scheduler/scoring | DEFER — only matters if published externally |
| L-Deps-2 | Low | forge-std submodule doc | DOC — short note in AGENTS.md |
| L-Deps-3 | Low | Vitest pin pattern | CLOSE-AS-PASS |
| I-Deps-1 | Info | Solidity 0.8.26 pinned | CLOSE-AS-PASS |

**Counts:** 4 Med / 3 Low / 1 Info → **0 CODE / 3 DOC / 3 DEFER / 2 CLOSE-AS-PASS**

---

## Polish 8 — Docs

Source: `audit/2026-05-PHASE-1-AUDIT/docs.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Docs-1 | Medium | runbook-operator.md cadence drift tolerance | DOC — add ±2 min / >5 min escalation paragraph |
| M-Docs-2 | Medium | zombie-tokens.md not linked from README | DOC — one-line ref under runbooks |
| M-Docs-3 | Medium | README doesn't note Sepolia redeploy status | DOC — add line + link to manifest |
| L-Docs-1 | Low | AGENTS.md URL canon doesn't mention staging | DOC — add staging-* sentence |
| I-Docs-1 | Info | Patchy NatSpec coverage on contracts | CLOSE-INCIDENTAL — covered by Polish 1 contracts NatSpec items |

**Counts:** 3 Med / 1 Low / 1 Info → **0 CODE / 4 DOC / 0 DEFER / 1 CLOSE-INCIDENTAL**

---

## Polish 9 — Performance

Source: `audit/2026-05-PHASE-1-AUDIT/performance.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Perf-1 | Medium | Bundle includes full wagmi/chains | CODE — run build, inspect, document outcome (likely no-op for genesis) |
| M-Perf-2 | Medium | React Query staleTime not set | CODE — `staleTime: 30_000` on admin/claim hooks |
| M-Perf-3 | Medium | No next/image | DEFER — Phase-2 (token avatars currently inline SVG glyphs, not raster) |
| L-Perf-1 | Low | ArenaLeaderboard rows not memoised | DEFER — premature for 12-row max |
| I-Perf-1 | Info | "use client" scoping correct | CLOSE-AS-PASS |

**Counts:** 3 Med / 1 Low / 1 Info → **2 CODE / 0 DOC / 2 DEFER / 1 CLOSE-AS-PASS**

---

## Polish 10 — Security

Source: `audit/2026-05-PHASE-1-AUDIT/security.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| H-Sec-CSP | High | No CSP headers configured | CODE — `next.config.mjs` `headers()` w/ CSP + X-Frame-Options + X-Content-Type-Options (carried into polish despite High; fits the security PR cleanly) |
| M-Sec-1 | Medium | PINATA_JWT deployment doc warning | DOC — `.env.example` + runbook |
| M-Sec-2 | Medium | Image URL no redirect/data-URI check | CODE — server HEAD-check + redirect inspection in metadata route |
| M-Sec-3 | Medium | Form validation client-side only | CODE — server re-validation in metadata route |
| L-Sec-1 | Low | SRI for Google Fonts | CLOSE-AS-PASS — next/font self-hosts at build time |
| L-Sec-2 | Low | CORS not documented for Pinata | DOC — one-line code comment |
| I-Sec-1 | Info | No `dangerouslySetInnerHTML` | CLOSE-AS-PASS |

**Counts:** 1 High / 3 Med / 2 Low / 1 Info → **3 CODE / 2 DOC / 0 DEFER / 2 CLOSE-AS-PASS**

> ⚠ The CSP High was missed in the High-batch dispatch; carrying it into Polish 10 because the surrounding security PR is the natural home. Will be flagged explicitly in PR description.

---

## Polish 11 — UX flows

Source: `audit/2026-05-PHASE-1-AUDIT/ux-flows.md`

| ID | Severity | Title | Disposition |
| --- | --- | --- | --- |
| M-Ux-1 | Medium | No prominent wallet-connect CTA on / | CODE — Connect button in TopBar |
| M-Ux-2 | Med→High | No actual trade panel | DEFER — Phase 2 trade panel (out of Phase 1 scope per ROADMAP) |
| M-Ux-3 | Medium | Token selection not URL-persisted | CODE — `?token=` query param sync |
| M-Ux-4 | Medium | Cost panel no loading state | CODE — skeleton/dashes while undefined |
| M-Ux-5 | Medium | Eligibility-blocked state copy | CODE — walk all eligibility branches, ensure actionable copy |
| M-Ux-6 | Medium | Cost lives in ref (live-cost surprise) | CLOSE-INCIDENTAL — closed by H-Web-2 in web-high-batch-3 |
| M-Ux-7 | Medium | Loading state during admin-data fetch | CODE — skeleton cards |
| M-Ux-8 | Medium | Tx pending/success states across admin sub-forms | CODE — verify + normalize |
| M-Ux-9 | Medium | Merkle proof failure surfaced as raw tx error | CODE — map known revert selectors |
| M-Ux-10 | Medium | No claim recovery path | DOC — "Need your claim again?" link to docs |
| M-Ux-11 | Medium | "Not yet claimed" vs "ineligible" confusion | DEFER — needs `eligibilityFor(address)` view; deferred to a contract follow-up |
| L-Ux-1 | Low | Time-window gating not visible | CODE — surface bonus window in page header |
| L-Ux-2 | Low | Slow-network FILTER_FIRED edge | CODE — fallback degraded state + re-fetch |
| L-Ux-3 | Low | No survivor-count guard | CODE — validate `survivors >= 1` |

**Counts:** 11 Med / 3 Low / 0 Info → **11 CODE / 1 DOC / 2 DEFER / 1 CLOSE-INCIDENTAL** (1 High carried to Security PR)

---

## Roll-up

| Bucket | CODE | DOC | DEFER | CLOSE | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Contracts | 6 | 4 | 1 | 4 | 15 |
| Indexer | 6 | 5 | 2 | 1 | 14 |
| Web general | 9 | 0 | 1 | 3 | 13 |
| Arena | 6 | 2 | 0 | 8 | 16 |
| A11y | 3 | 0 | 0 | 2 | 5 |
| Brand | 2 | 3 | 0 | 2 | 7 |
| Deps | 0 | 3 | 3 | 2 | 8 |
| Docs | 0 | 4 | 0 | 1 | 5 |
| Performance | 2 | 0 | 2 | 1 | 5 |
| Security | 3 | 2 | 0 | 2 | 7 |
| UX flows | 11 | 1 | 2 | 1 | 15 |
| **Total** | **48** | **24** | **11** | **27** | **110** |

After all 11 polish PRs land:
- Audit one-pager line: "Internal Phase 1 audit — Critical/High/Medium/Low/Info: closed (108 findings remediated; 11 deferred to Phase 2 with explicit notes)."
- Each per-file audit doc has every row carrying a status note (✅ FIXED / 📋 DOC / 🚧 DEFER / 🔍 CLOSE-AS-PASS / ↩ CLOSE-INCIDENTAL).
- The catalogue stops being a backlog and becomes the regression layer.

