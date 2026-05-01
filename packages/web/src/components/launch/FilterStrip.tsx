"use client";

/// Full-width filter-mechanic strip (spec §18.7).
///
///   ▼  THE FILTER  Top 6 survive. Bottom 6 get cut. Their liquidity funds the winner.
///
/// Anchors the page emotionally between hero + slot grid.

import {Triangle} from "@/components/Triangle";
import {C, F} from "@/lib/tokens";

export function FilterStrip() {
  return (
    <section
      aria-label="Filter mechanic"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "16px 20px",
        borderRadius: 14,
        border: `1px solid ${C.red}55`,
        background:
          "linear-gradient(135deg, rgba(255,45,85,0.10), rgba(156,92,255,0.06) 60%, transparent)",
        overflow: "hidden",
      }}
    >
      <Triangle size={32} />
      <div style={{flex: 1, minWidth: 0}}>
        <div
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.dim,
            letterSpacing: "0.18em",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          The filter
        </div>
        <div style={{fontSize: 16, fontFamily: F.display, fontWeight: 800}}>
          <span style={{color: C.green}}>Top 6 survive.</span>{" "}
          <span style={{color: C.red}}>Bottom 6 get cut.</span>{" "}
          <span style={{color: C.dim, fontWeight: 600}}>Their liquidity funds the winner.</span>
        </div>
      </div>
      <SurviveFilteredKey />
    </section>
  );
}

function SurviveFilteredKey() {
  return (
    <div style={{display: "flex", alignItems: "center", gap: 14, flexShrink: 0}}>
      <KeyBlock color={C.green} label="✓ SURVIVE" foot="+ pooled liq" />
      <KeyBlock color={C.red} label="× FILTERED" foot="→ pool" />
    </div>
  );
}

function KeyBlock({color, label, foot}: {color: string; label: string; foot: string}) {
  return (
    <div style={{display: "flex", alignItems: "center", gap: 8}}>
      <div style={{display: "flex", gap: 2}}>
        {Array.from({length: 6}).map((_, i) => (
          <div
            key={i}
            style={{
              width: 4,
              height: 14,
              borderRadius: 2,
              background: color,
              opacity: 0.5 + (i % 2) * 0.5,
            }}
          />
        ))}
      </div>
      <div style={{display: "flex", flexDirection: "column", lineHeight: 1.1}}>
        <span style={{fontFamily: F.mono, fontWeight: 800, fontSize: 9, letterSpacing: "0.16em", color}}>
          {label}
        </span>
        <span style={{fontFamily: F.mono, fontSize: 9, color: C.faint, letterSpacing: "0.14em"}}>{foot}</span>
      </div>
    </div>
  );
}
