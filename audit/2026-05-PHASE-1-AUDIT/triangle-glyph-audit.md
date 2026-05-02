# Triangle Glyph Audit — ▼ vs 🔻
**Audit Date:** 2026-05-01

Scope: every occurrence of ▼ (U+25BC) and 🔻 (U+1F53B) in repo files (packages/, docs/, AGENTS.md, README.md). Brand mark is ▼; 🔻 is acceptable only on the wire payload (SSE) by design.

## Method
- `grep -rn "▼" packages/ docs/ AGENTS.md README.md`
- `grep -rn "🔻" packages/ docs/ AGENTS.md README.md`

## 🔻 occurrences (12)

| File:line | Surface | Verdict | Notes |
|---|---|---|---|
| `packages/web/test/arena/Ticker.test.tsx:73-77` | test-fixture | PASS | Comment explicitly documents intent (mirrors indexer wire payload). |
| `packages/web/src/components/Triangle.tsx:9` | internal-comment | PASS | Comment in self-documenting file. |
| `packages/web/src/components/Triangle.tsx:17` | internal-comment | PASS | Same. |
| `packages/web/src/components/arena/ArenaTicker.tsx:253` | internal-comment | PASS | Documents wire payload origin. |
| `packages/indexer/README.md:148` | doc example | PASS | Example payload illustrating the SSE shape. |
| `packages/indexer/src/api/events/message.ts:10` | internal-comment | PASS | Direction-symbols list. |
| `packages/indexer/src/api/events/message.ts:66` | wire-payload | PASS-by-design | CUT_LINE_CROSSED message body. **Verify Ticker swaps to ▼ on render — see ArenaTicker behaviour.** |
| `packages/indexer/src/api/events/message.ts:89` | wire-payload | PASS-by-design | FILTER_FIRED. |
| `packages/indexer/src/api/events/message.ts:92` | wire-payload | PASS-by-design | FILTER_COUNTDOWN. |
| `packages/indexer/src/api/events/config.ts:59` | internal-comment | PASS | Documents the FILTER_COUNTDOWN trigger. |

**HOLE in the swap chain:** the agent confirmed that ArenaTicker.tsx renders `headline.message` *verbatim*, so any 🔻 in the indexer payload reaches the user as 🔻. The fallback string uses ▼ but the live message does not get rewritten. This is consistent with the documented test fixture. Two ways to read this:

1. The implicit design intent is that ticker payloads display verbatim and the 🔻 is *deliberately* visible as a shorthand inside short ticker chips. AGENTS.md / spec §32.4 + brand-kit lock the **brand mark** as ▼; arguably ticker payloads are not the "brand mark" surface.
2. Any user-visible 🔻 violates the override.

**Recommendation (separate finding):** clarify in AGENTS.md or ARENA_SPEC §32.4 which user-facing surfaces *may* keep the 🔻 emoji. If the answer is "none", add a swap step in `ArenaTicker.tsx` that replaces 🔻 with the inline ▼ on render (the Triangle component supports inline mode). Severity: **High** if interpretation #2; **Info** if interpretation #1. Recorded in `arena.md` and the executive summary.

## ▼ occurrences (sample — all PASS)

- packages/web/src/app/layout.tsx:32, 37, 49 — meta description / OG (`Get filtered or get funded ▼`)
- packages/web/src/app/page.tsx:287 — `Champion Pool ▼`
- packages/web/src/components/launch/{LaunchForm.tsx, LaunchHero.tsx, FilterStrip.tsx, SlotGrid.tsx} — labels, button copy, comments
- packages/web/src/components/arena/ArenaTicker.tsx:256 — fallback `▼ FILTER LIVE`
- packages/web/src/components/arena/ArenaLeaderboard.tsx:334, 437 — filter stamp + AT RISK chip
- packages/web/src/components/arena/ArenaTokenDetail.tsx:202 — chip
- packages/web/src/components/arena/StatusBadge.tsx:52 — FILTERED status icon
- packages/web/src/components/admin/{BagLockCard.tsx:169, SurvivalActions.tsx:34}
- packages/web/src/components/arena/filterMoment/FilterEventReveal.tsx:77,79 — `<Triangle inline />`
- README.md:1, 3, 29 — wordmark/tagline doc

All ▼ instances render the unicode glyph directly or via the Triangle SVG component (gradient pink→red, unique id per instance via `useId()`).

## Summary

- Total occurrences: ~44 (12 × 🔻, ~32 × ▼)
- ▼ usage: PASS everywhere
- 🔻 usage: 5 internal comments + 1 doc example + 1 test fixture + 4 wire-payload sites (PASS-by-design); 1 latent risk in ticker render path (see "HOLE" above)
- FAIL count if interpretation #2: 4 (the 4 wire-payload messages reach the user as 🔻)
- FAIL count if interpretation #1: 0

TOTAL: Critical=0 High=0-1 (depending on interpretation) Medium=0 Low=0 Info=1
