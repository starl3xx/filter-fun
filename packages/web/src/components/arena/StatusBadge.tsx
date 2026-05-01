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
      {icon ? <span aria-hidden>{icon}</span> : null}
      {label}
    </span>
  );
}

function treatmentFor(status: TokenStatus): {color: string; label: string; icon: string | null} {
  switch (status) {
    case "FINALIST":
      return {color: C.yellow, label: "Finalist", icon: "🏆"};
    case "SAFE":
      return {color: C.green, label: "Safe", icon: null};
    case "AT_RISK":
      return {color: "#ffa940", label: "At risk", icon: "⚠️"};
    case "FILTERED":
      return {color: C.red, label: "Filtered", icon: "▼"};
  }
}
