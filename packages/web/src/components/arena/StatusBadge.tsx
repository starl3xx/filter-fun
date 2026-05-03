/// Status badge — single source of truth for the SAFE / AT_RISK / FINALIST /
/// FILTERED visual treatment. Indexer returns the status enum directly
/// (`packages/indexer/src/api/status.ts`); this component just renders it.

import type {TokenStatus} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

export type StatusBadgeProps = {
  status: TokenStatus;
  /// Compact rendering — drops the explicit text label and just shows the
  /// status pill. Useful in narrow rows.
  compact?: boolean;
};

export function StatusBadge({status, compact}: StatusBadgeProps) {
  const {color, label, icon} = treatmentFor(status);
  return (
    <span
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: compact ? "1px 7px" : "2px 9px",
        borderRadius: 99,
        background: `${color}1a`,
        border: `1px solid ${color}55`,
        color,
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: compact ? 9 : 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </span>
  );
}

function treatmentFor(status: TokenStatus): {color: string; label: string; icon: string} {
  switch (status) {
    case "FINALIST":
      return {color: C.yellow, label: "Finalist", icon: "🏆"};
    case "SAFE":
      // Audit H-A11y-2 (ARENA_SPEC §12 icon+colour rule). Pre-fix `icon: null`
      // conveyed status by green colour alone — fails for colour-blind users.
      // ✓ (U+2713 CHECK MARK) is the colour-independent glyph.
      return {color: C.green, label: "Safe", icon: "✓"};
    case "AT_RISK":
      // ARENA_SPEC §3.3 — AT_RISK is red ▼ (U+25BC), not orange ⚠️. Audit
      // H-Arena-3 caught the pre-fix orange/⚠️ pair which both broke the
      // colour-icon contract and duplicated a different glyph from the AT RISK
      // chip elsewhere in the leaderboard. ▼ is the literal Unicode glyph,
      // NOT the 🔻 emoji — the emoji renders as a coloured photo character on
      // some platforms which collides with the red CSS colour.
      return {color: C.red, label: "At risk", icon: "▼"};
    case "FILTERED":
      return {color: C.red, label: "Filtered", icon: "▼"};
  }
}
