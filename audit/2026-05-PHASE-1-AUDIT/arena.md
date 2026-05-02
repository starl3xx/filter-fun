# Phase-1 Arena Audit (ARENA_SPEC.md compliance)
filter.fun web — Arena page
**Audit Date:** 2026-05-01

---

## CRITICAL

### [Arena] Bricolage Grotesque — weights 500 + 600 not loaded
**Severity:** Critical
**Files:** packages/web/src/app/layout.tsx:8-13
**Spec ref:** ARENA_SPEC §2.1, §2.2

**Description:**
Spec mandates 5 Bricolage Grotesque weights (400, 500, 600, 700, 800). The next/font import only loads 400, 700, 800. Type roles T2 / T4 / others requesting 500 / 600 silently fall back to a near weight, breaking visual hierarchy across the page.

**Evidence:**
```tsx
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "700", "800"],
  display: "swap",
  variable: "--font-display",
});
```

**Recommendation:** Add `"500"` and `"600"` to the weight array.

**Effort:** XS

---

## HIGH

### [Arena] TICKER_COLORS map drifts from ARENA_SPEC §3.2
**Severity:** High
**Files:** packages/web/src/lib/tokens.ts:29-42
**Spec ref:** ARENA_SPEC §3.2

**Description:**
11 of 12 entries in TICKER_COLORS use non-spec hex values. FILTER is wired to yellow `#ffe933` instead of pink `#ff3aa1`; BLOOD/MOON/CUT/EDGE/SLICE/RUG/DUST/GHOST/KING all drift. This breaks token avatar colors, ticker glows, and finalist halos.

**Evidence:**
Spec:
```js
const TICKER_COLORS = {
  FILTER: '#ff3aa1', BLOOD: '#ff2d55', KING: '#ffe933', SURVIVE: '#52ff8b',
  MOON: '#9c5cff', FINAL: '#00f0ff', CUT: '#ff8aa1', EDGE: '#ffaa3a',
  SLICE: '#aaff3a', RUG: '#ff5577', DUST: '#aa88ff', GHOST: '#88aacc',
}
```
Code (excerpt):
```ts
FILTER: "#ffe933",   // spec: #ff3aa1
BLOOD: "#ff5d8c",    // spec: #ff2d55
KING: "#ffb020",     // spec: #ffe933
MOON: "#a78bfa",     // spec: #9c5cff
RUG: "#9ca3af",      // spec: #ff5577
```

**Recommendation:** Replace map with spec-exact values.

**Effort:** S

### [Arena] HpBar uses single 4-color spectrum globally instead of status-driven gradient
**Severity:** High
**Files:** packages/web/src/components/arena/HpBar.tsx:62-67, packages/web/src/components/arena/ArenaLeaderboard.tsx:370
**Spec ref:** ARENA_SPEC §6.4.3

**Description:**
Spec requires gradient by status: finalist `yellow→pink`, safe `green→cyan`, risk `red→pink`. Implementation derives a single fill colour from HP value and ignores the row's status.

**Evidence:**
```ts
function colorForHp(hp: number): string {
  if (hp >= 75) return C.cyan;
  if (hp >= 50) return C.green;
  if (hp >= 30) return "#ffa940";
  return C.red;
}
```

**Recommendation:** Pass `status` prop to ArenaHpBar; switch to the spec gradient per status. Keep the spectrum logic only as fallback.

**Effort:** M

### [Arena] AT_RISK status badge uses orange ⚠️ icon instead of red ▼
**Severity:** High
**Files:** packages/web/src/components/arena/StatusBadge.tsx:50
**Spec ref:** ARENA_SPEC §3.3

**Description:**
Spec maps risk status to `--red` colour with ▼ icon. Code uses `#ffa940` orange + ⚠️ emoji, which (a) breaks the colour-icon contract, and (b) duplicates a different glyph from the `AT RISK` chip elsewhere in the leaderboard which already uses ▼.

**Recommendation:** `case "AT_RISK": return {color: C.red, label: "At risk", icon: "▼"};`

**Effort:** XS

### [Arena] HP breakdown bars use single cyan→pink gradient (should be per-component)
**Severity:** High
**Files:** packages/web/src/components/arena/ArenaTokenDetail.tsx:289
**Spec ref:** ARENA_SPEC §6.5.3

**Description:**
Spec maps each HP component to its own colour: Velocity → pink, Buyers → cyan, Liquidity → yellow, Retention → green. Code uses one shared gradient (`linear-gradient(90deg, ${C.cyan}, ${C.pink})`) for all four bars and label.

**Recommendation:** Build HP_COMPONENT_COLORS map; apply to both label and gradient.

**Effort:** S

### [Arena] LIVE pill styling deviates from spec (padding, border alpha)
**Severity:** High → Medium
**Files:** packages/web/src/components/arena/ArenaTopBar.tsx:99-104
**Spec ref:** ARENA_SPEC §6.1

**Description:**
Spec: `padding: 5px 11px`, bg @ 12%, border @ 40%. Code: `padding: 3px 10px`, bg `1a` (~10%), border `55` (~33%).

**Recommendation:** Hardcode spec values OR pass them through Pill props.

**Effort:** XS

### [Arena] Top bar Brand wordmark renders all-white (`.fun` should be pink)
**Severity:** High
**Files:** packages/web/src/components/arena/ArenaTopBar.tsx:82-91
**Spec ref:** ARENA_SPEC §6.1

**Description:**
Spec: `filter` white + `.fun` pink. Code renders the whole string in default colour.

**Recommendation:** Split into two spans:
```tsx
<span style={{color: C.text}}>filter</span><span style={{color: C.pink}}>.fun</span>
```

**Effort:** XS

---

## MEDIUM

### [Arena] Leaderboard column grid widths drift from spec
**Severity:** Medium
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx:51,159
**Spec ref:** ARENA_SPEC §6.4.2

**Description:**
Spec: `34 28 1fr 86 84 70 96 24`. Code: `32 30 minmax(0,1fr) 116 92 84 78 74`. Every column except the name slot is mis-sized; cells will not align with the spec mockup.

**Recommendation:** Either adopt spec exactly or update spec to match the responsive variant. If user-decided "responsive (not fixed 1440)", document the rationale.

**Effort:** S

### [Arena] Activity feed has no event-type → icon/colour map
**Severity:** Medium
**Files:** packages/web/src/components/arena/ArenaActivityFeed.tsx:73-82
**Spec ref:** ARENA_SPEC §6.6

**Description:**
Spec defines 8 event types each with its own icon + colour (enter 🚀 cyan / risk ▼ red / pump 📈 green / whale 🐋 purple / mission 🎯 yellow / launch ✨ pink / cross ⚠️ red / lead 👑 yellow). Implementation only colour-codes by priority bucket.

**Recommendation:** Build EVENT_TYPE_STYLES map and render `<span aria-hidden>{icon}</span>` + coloured tile per item.

**Effort:** M

### [Arena] Activity feed header missing 📡 icon and STREAMING pill
**Severity:** Medium → Low
**Files:** packages/web/src/components/arena/ArenaActivityFeed.tsx:35-39
**Spec ref:** ARENA_SPEC §6.6

**Description:**
Spec: header has 📡 + title + STREAMING pill (pulsing green dot). Code shows title + "Recent · N" right-aligned.

**Recommendation:** Add the icon and a small Pill component reusing the LIVE pill pattern.

**Effort:** S

### [Arena] HP breakdown labels rendered in dim instead of component colour
**Severity:** Medium
**Files:** packages/web/src/components/arena/ArenaTokenDetail.tsx:274-279
**Spec ref:** ARENA_SPEC §6.5.3

**Description:**
Spec: labels coloured per component (Velocity pink, Buyers cyan, etc.). Code: `color: C.dim` for all.

**Recommendation:** Apply HP_COMPONENT_COLORS to label and bar (single fix with the gradient finding above).

**Effort:** XS (combined)

### [Arena] JetBrains Mono — weights 400 + 600 missing, weight 800 added (not in spec)
**Severity:** Medium
**Files:** packages/web/src/app/layout.tsx:15-20
**Spec ref:** ARENA_SPEC §2.1

**Description:**
Spec requires 400/500/600/700. Code loads 500/700/800.

**Recommendation:** `weight: ["400", "500", "600", "700"]`.

**Effort:** XS

### [Arena] Top-bar stat value font size 16 vs spec 14
**Severity:** Medium → Low
**Files:** packages/web/src/components/arena/ArenaTopBar.tsx:155
**Spec ref:** ARENA_SPEC §2.3 (T7)

**Recommendation:** `fontSize: 14`.

**Effort:** XS

### [Arena] Responsive grid is mobile-first; spec requires fixed 1440×980
**Severity:** Medium (Design Decision)
**Files:** packages/web/src/app/globals.css:162-189, packages/web/src/app/page.tsx:204
**Spec ref:** ARENA_SPEC §5

**Description:**
User-decided departure ("responsive (not fixed 1440)" per project memory). Document the rationale to prevent it being treated as drift in future audits.

**Recommendation:** Add a one-line note in ARENA_SPEC + a comment in globals.css stating: "Intentional: responsive grid replaces the spec 1440×980 fixed canvas; see project memory."

**Effort:** XS (documentation only)

### [Arena] Leaderboard header grid not aligned to row grid (same wrong widths)
**Severity:** Medium
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx:159
**Spec ref:** ARENA_SPEC §6.4.1-§6.4.3

**Description:**
ColumnHeader reuses COL_TEMPLATE; if widths are wrong, header drifts in same direction. Fixed by the leaderboard column grid finding above.

**Recommendation:** Combined fix.

**Effort:** combined

---

## LOW

### [Arena] Leaderboard rows below cut use opacity 0.62; spec calls for 0.5 only at ranks 11-12
**Severity:** Low
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx:270
**Spec ref:** ARENA_SPEC §3.3

**Recommendation:** Apply opacity 0.5 only to indices 10-11; keep 7-10 at full opacity.

**Effort:** S

### [Arena] Cut line badge uses ambiguous "5×14 padded pill" interpretation
**Severity:** Low
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx:214-231
**Spec ref:** ARENA_SPEC §6.4.4

**Description:** Spec notation is ambiguous; current implementation reasonable but unverified.

**Recommendation:** Clarify spec; verify rendered height in DevTools.

**Effort:** XS

### [Arena] Leaderboard row missing chevron column (8th cell)
**Severity:** Low
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx:236-407
**Spec ref:** ARENA_SPEC §6.4.3

**Description:** Spec calls for a `›` chevron 14/900, pink if selected else faint, in the 8th grid cell. Row only renders 7 columns.

**Recommendation:** Append chevron span; colour driven by selection state.

**Effort:** XS

### [Arena] Top bar gap between sections is 12 (spec 22)
**Severity:** Low
**Files:** packages/web/src/components/arena/ArenaTopBar.tsx:48
**Spec ref:** ARENA_SPEC §6.1

**Recommendation:** `gap: 22`.

**Effort:** XS

### [Arena] Top bar padding `12px 18px` (spec `0 22px`); height not explicitly 56px
**Severity:** Low
**Files:** packages/web/src/components/arena/ArenaTopBar.tsx:49
**Spec ref:** ARENA_SPEC §6.1

**Recommendation:** Update padding; assert height via `min-height: 56px`.

**Effort:** XS

### [Arena] Finalist HP score lacks yellow text-shadow glow
**Severity:** Low
**Files:** packages/web/src/components/arena/HpBar.tsx:54
**Spec ref:** ARENA_SPEC §6.4.3

**Description:** Spec: finalist HP number gets `text-shadow: 0 0 8px var(--yellow)/40%`.

**Recommendation:** Pass status prop into HpBar and apply when finalist.

**Effort:** S

---

## INFO

### [Arena] Triangle component renders correctly (gradient pink→red, unique id)
**Severity:** Info
**Files:** packages/web/src/components/Triangle.tsx
**Spec ref:** comprehensive spec §32.4

### [Arena] Cut-line badge, FILTERED status, AT-RISK chip, firing-mode stamp all use ▼
**Severity:** Info
**Files:** packages/web/src/components/arena/{StatusBadge.tsx, ArenaLeaderboard.tsx}

### [Arena] Ticker fallback uses ▼; live wire payload may contain 🔻 (intentional, documented)
**Severity:** Info
**Files:** packages/web/src/components/arena/ArenaTicker.tsx:250-256

### [Arena] StatusBadge uses icon + label per ARENA_SPEC §12 a11y
**Severity:** Info
**Files:** packages/web/src/components/arena/StatusBadge.tsx:36-39

### [Arena] Sparkline colour fallback (zero change → cyan/dim by HP) is reasonable but spec-silent
**Severity:** Info
**Files:** packages/web/src/components/arena/ArenaLeaderboard.tsx:461-466

---

TOTAL: Critical=1 High=6 Medium=8 Low=6 Info=5
