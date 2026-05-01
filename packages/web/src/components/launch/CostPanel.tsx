"use client";

/// Cost panel for the /launch claim form (spec §18.5).
///
///   ┌──────────────────────────────────┐
///   │ Slot #N                          │
///   │ Launch cost     Ξ0.086           │
///   │ Refund. stake   Ξ0.086           │
///   │ ────────────────                  │
///   │ Total           Ξ0.172           │
///   │ "Stake refunds to your wallet…"  │
///   └──────────────────────────────────┘

import {C, F} from "@/lib/tokens";
import {fmtEthFromWei} from "@/lib/launch/format";

export type CostPanelProps = {
  slotIndex: number;
  launchCostWei: bigint;
  /// Stake amount (matches launchCost when refundableStakeEnabled). 0 if
  /// stake mode is off — the panel hides the row in that case.
  stakeWei: bigint;
};

export function CostPanel({slotIndex, launchCostWei, stakeWei}: CostPanelProps) {
  const total = launchCostWei + stakeWei;
  const stakeOn = stakeWei > 0n;
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.03)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.cyan,
          }}
        >
          Slot #{String(slotIndex + 1).padStart(2, "0")}
        </span>
      </div>
      <Row label="Launch cost" value={fmtEthFromWei(launchCostWei)} />
      {stakeOn && <Row label="Refundable stake" value={fmtEthFromWei(stakeWei)} />}
      <div style={{height: 1, background: C.line}} />
      <Row label="Total" value={fmtEthFromWei(total)} bold />
      {stakeOn && (
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: C.dim,
            lineHeight: 1.45,
          }}
        >
          Stake refunds to your wallet if your token survives Friday's cut.{" "}
          <span style={{color: C.red}}>Forfeited if filtered.</span>
        </p>
      )}
    </div>
  );
}

function Row({label, value, bold}: {label: string; value: string; bold?: boolean}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline"}}>
      <span
        style={{
          fontSize: 11,
          color: bold ? C.text : C.dim,
          fontWeight: bold ? 800 : 600,
          fontFamily: F.mono,
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: bold ? 16 : 13,
          color: C.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}
