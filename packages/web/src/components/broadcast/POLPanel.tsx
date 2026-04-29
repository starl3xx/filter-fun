"use client";

import {fmtUSD} from "@/lib/format";
import type {POLStats} from "@/hooks/usePOLStats";
import {C, F} from "@/lib/tokens";

/// Surfaces the contract's POL accounting to the broadcast UI:
/// - polReserve: WETH the protocol has accumulated this week, waiting on the winner.
/// - projectedWinnerBacking: indexer projection of total backing the winner will get.
/// - finalPOLDeployed: realized after settlement.
///
/// Shown as a small card so the user can see capital concentrating in real-time while the
/// game runs, then crystallizing into the winner at the end.
export function POLPanel({stats, ethToUsd = 3500}: {stats: POLStats; ethToUsd?: number}) {
  const settled = stats.finalPOLDeployed > 0;
  return (
    <section
      aria-label="Protocol-owned liquidity"
      style={{
        borderRadius: 14,
        padding: "12px 16px",
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${C.line}`,
        backdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <h3
          style={{
            margin: 0,
            fontSize: 11,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 800,
            textTransform: "uppercase",
          }}
        >
          Winner backing
        </h3>
        <span
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: settled ? C.green : C.cyan,
            padding: "2px 7px",
            background: settled ? `${C.green}1a` : `${C.cyan}1a`,
            border: `1px solid ${settled ? C.green : C.cyan}55`,
            borderRadius: 99,
            letterSpacing: "0.1em",
            fontWeight: 800,
          }}
        >
          {settled ? "DEPLOYED" : "ACCUMULATING"}
        </span>
      </div>

      <div style={{display: "flex", alignItems: "baseline", gap: 8}}>
        <span style={{fontSize: 26, fontFamily: F.display, fontWeight: 900, color: C.text, letterSpacing: "-0.02em"}}>
          {fmtUSD((settled ? stats.finalPOLDeployed : stats.polReserve) * ethToUsd)}
        </span>
        <span style={{fontSize: 11, fontFamily: F.mono, color: C.dim}}>
          {(settled ? stats.finalPOLDeployed : stats.polReserve).toFixed(2)} WETH
        </span>
      </div>

      <div
        style={{
          fontSize: 10,
          fontFamily: F.mono,
          color: C.dim,
          letterSpacing: "0.04em",
          lineHeight: 1.5,
        }}
      >
        {settled ? (
          <>Final reserve deployed into the winner.</>
        ) : (
          <>
            Held as WETH; deployed to the winner at settlement. Projected backing{" "}
            <span style={{color: C.cyan, fontWeight: 700}}>{fmtUSD(stats.projectedWinnerBacking * ethToUsd)}</span>.
          </>
        )}
      </div>
    </section>
  );
}
