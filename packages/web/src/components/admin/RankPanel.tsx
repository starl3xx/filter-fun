"use client";

import type {TokenStats} from "@/hooks/token/useTokenStats";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

const COLORS: Record<TokenStats["cutLineStatus"], string> = {
  SAFE: C.green,
  AT_RISK: "#ffa940",
  DANGER: C.red,
  FINALIST: C.yellow,
  FILTERED: C.faint,
};

/// Rank + cut-line distance ("SAFE by 4" / "AT RISK by 1" / "FILTERED").
/// Uses the derived `cutLineLabel` from `useTokenStats` so the copy is
/// computed in one place and consumed identically across surfaces.

export function RankPanel({stats}: {stats: TokenStats}) {
  const color = COLORS[stats.cutLineStatus];
  const rank = stats.token?.rank ?? 0;
  return (
    <Card label="Rank">
      <div style={{display: "flex", alignItems: "baseline", gap: 12}}>
        <span style={{fontSize: 34, fontWeight: 800, fontFamily: F.display, color: C.text}}>
          {rank > 0 ? `#${rank}` : "—"}
        </span>
        <span style={{fontSize: 12, color: C.dim, fontFamily: F.mono}}>of 12</span>
      </div>
      <div
        style={{
          marginTop: 8,
          padding: "5px 10px",
          borderRadius: 99,
          background: `${color}1a`,
          border: `1px solid ${color}55`,
          color,
          fontSize: 11,
          fontFamily: F.mono,
          fontWeight: 800,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          display: "inline-block",
        }}
      >
        {stats.cutLineLabel || "—"}
      </div>
    </Card>
  );
}
