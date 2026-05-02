# ARENA_SPEC §14 QA Checklist — verdicts
**Audit Date:** 2026-05-01

(Override: 🔻 in the spec means render ▼ in code.)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Top-bar accents — countdown red, pool yellow, backing cyan, all glow | PARTIAL | `ArenaTopBar.tsx` Stat helper applies per-accent colour but LIVE pill padding/border alpha drift from §6.1 (see Arena High finding). |
| 2 | Wordmark `.fun` is pink, ▼ has red glow | PARTIAL | ▼ glow correct (Triangle.tsx + drop-shadow on ArenaTopBar:85-87). `.fun` renders in default colour, not pink (Arena High finding). |
| 3 | Story ticker scrolls R→L over 90s, pauses on hover, masks both edges | PASS | ArenaTicker scroll/mask CSS verified; 90s duration confirmed in component. |
| 4 | Champion pool card — gradient text, yellow border + soft yellow box-shadow | PASS | page.tsx Champion Pool card uses gradient text and proper border. |
| 5 | Filter mechanic card — green "Top 6 survive" + red "Bottom 6 cut" | PASS | FilterStrip.tsx renders both copy variants in correct colours. |
| 6 | Leaderboard grid `34 / 28 / 1fr / 86 / 84 / 70 / 96 / 24` | FAIL | COL_TEMPLATE in ArenaLeaderboard.tsx:51 = `32 30 minmax(0,1fr) 116 92 84 78 74` (Arena Medium finding). |
| 7 | Selected row — pink gradient + pink hairline + pink glow | PASS | Row component applies pink gradient on `selected` state. |
| 8 | Avatar colours match TICKER_COLORS (FILTER pink, BLOOD red, KING yellow, …) | FAIL | TICKER_COLORS map in tokens.ts:29-42 has 11/12 entries wrong (Arena High finding). |
| 9 | HP bar gradient by status — finalist yellow→pink / safe green→cyan / risk red→pink | FAIL | HpBar.tsx uses fixed cyan/green/orange/red spectrum from HP value (Arena High finding). |
| 10 | Cut line — 45° red repeating stripes, both red borders, badge centered-left, countdown right | PASS | ArenaLeaderboard.tsx:214-231 implements the cut line. (Minor: badge "5×14 padded pill" notation ambiguous; see Arena Low finding.) |
| 11 | Token detail border + glow colour matches selected status | PASS | ArenaTokenDetail.tsx applies status-driven border / glow. |
| 12 | HP breakdown — Velocity pink / Buyers cyan / Liquidity yellow / Retention green | FAIL | All four bars share single cyan→pink gradient; labels rendered in dim (Arena High + Medium findings). |
| 13 | BUY CTA green→cyan dark text; SELL CTA red→pink white text | UNKNOWN | Trade panel was not located in the audit slice (UX flow 2 finding). May be deferred to Phase 2. |
| 14 | Activity feed icons & colours per §6.6 mapping | FAIL | ArenaActivityFeed.tsx has no type→icon/colour map; only priority colouring (Arena Medium finding). |
| 15 | All numbers tabular-nums, no horizontal jitter on live ticks | PARTIAL | Tabular numerics applied via JetBrains Mono on most numeric elements; spot-check confirmed for HP, prices, % deltas. Some lonely places (e.g., countdown) use display font — verify no jitter. |
| 16 | `prefers-reduced-motion` kills marquee + pulses | PASS | globals.css §437 honours `prefers-reduced-motion: reduce`. |

### Section-level checklists (selected from §6.1-§6.6)

- §6.1 wordmark with `.fun` pink — **FAIL** (high finding)
- §6.1 LIVE pill spec values (padding 5px 11px, bg 12%, border 40%) — **FAIL**
- §6.1 height 56 px / padding 0 22px — **PARTIAL** (padding wrong)
- §6.2 ticker right-to-left 90s + edge masks — **PASS**
- §6.2 ticker pauses on hover — **PASS**
- §6.3 champion strip 3 cards (Champion Pool + Backing + Filter mechanic) — **PASS**
- §6.4 cut line stripes + badge — **PASS**
- §6.4 ranks 11-12 opacity 0.5 — **FAIL** (uses 0.62 for all below-cut; Arena Low finding)
- §6.5 token detail 440px wide — **PARTIAL** (responsive grid, not fixed)
- §6.5 chart 64-point sparkline — **PASS**
- §6.5 HP breakdown 2×2 with component-specific colours — **FAIL**
- §6.6 activity feed 168 px, 8 of 14 items shown — **PARTIAL** (height ok; type→icon/colour mapping missing)
- §8 fmtPrice/fmtUSD/fmtNum/fmtCountdown/fmtAgo — **PASS** (formatters in lib/, used consistently)
- §9 token tick every 1.4s — **PASS**
- §9 countdown every 1s — **PASS**
- §10 48 absolute-positioned twinkle dots — **PASS** (Stars.tsx)
- §11 sort modes — **PARTIAL** (sort state exists; UI affordance verification pending)
- §12 status pills carry icon + colour — **PARTIAL** (SAFE has icon: null — A11y High finding)

### Score
- PASS: 11
- PARTIAL: 6
- FAIL: 7
- UNKNOWN: 1
