"use client";

/// Stats grid — Epic 1.24 (spec §38). Wins · filters survived · rollover ·
/// bonus · lifetime trade volume. Source fields all come from the existing
/// `/profile/:address` payload (PR #45 enrichment), so this is purely a
/// presentation component.

import {C, F} from "@/lib/tokens";
import {fmtEthShort} from "@/lib/token/format";

import type {ProfileResponse} from "@/lib/arena/api";

const TILE_STYLE = {
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 12,
  padding: "16px 20px",
  display: "flex",
  flexDirection: "column" as const,
  gap: 6,
};

export function ProfileStats({stats}: {stats: ProfileResponse["stats"]}) {
  const tiles: Array<{label: string; value: string; color?: string}> = [
    {label: "Wins", value: stats.wins.toString(), color: C.yellow},
    {label: "Filters survived", value: stats.filtersSurvived.toString(), color: C.cyan},
    {label: "Rollover earned", value: fmtEthShort(BigInt(stats.rolloverEarnedWei || "0"))},
    {label: "Bonus earned", value: fmtEthShort(BigInt(stats.bonusEarnedWei || "0"))},
    {
      label: "Lifetime volume",
      value: fmtEthShort(BigInt(stats.lifetimeTradeVolumeWei || "0")),
    },
    {label: "Tokens traded", value: stats.tokensTraded.toString()},
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 12,
      }}
    >
      {tiles.map((t) => (
        <div key={t.label} style={TILE_STYLE}>
          <div style={{fontSize: 11, color: C.dim, letterSpacing: "0.04em", textTransform: "uppercase"}}>
            {t.label}
          </div>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 22,
              fontWeight: 600,
              color: t.color ?? C.text,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {t.value}
          </div>
        </div>
      ))}
    </div>
  );
}
