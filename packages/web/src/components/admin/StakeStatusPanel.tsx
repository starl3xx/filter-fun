"use client";

import type {StakeStatus} from "@/hooks/token/useStakeStatus";
import {fmtEthShort} from "@/lib/token/format";
import {C, F} from "@/lib/tokens";

import {Card, Field} from "./Card";

const STATE_LABELS: Record<StakeStatus["state"], {label: string; color: string; copy: string}> = {
  HELD: {
    label: "Held until first cut",
    color: C.yellow,
    copy: "Refunds if your token survives Friday's hard cut. Forfeited if filtered.",
  },
  REFUNDED: {
    label: "Refunded ✓",
    color: C.green,
    copy: "Survived the soft filter — original stake returned to the creator.",
  },
  FORFEITED: {
    label: "Forfeited",
    color: C.red,
    copy: "Filtered early — stake routed to the forfeit recipient.",
  },
  PROTOCOL: {
    label: "Protocol launch",
    color: C.cyan,
    copy: "Launched via the protocol-bypass path — no refundable stake applies.",
  },
  UNKNOWN: {
    label: "Unknown",
    color: C.faint,
    copy: "Stake state could not be resolved. Try refreshing.",
  },
};

/// Three-state stake status panel: HELD / REFUNDED / FORFEITED, plus the
/// PROTOCOL and UNKNOWN edge cases. The pill color and copy come from a
/// single mapping — adding a state means editing one place.

export function StakeStatusPanel({status}: {status: StakeStatus}) {
  const treatment = STATE_LABELS[status.state];
  const stake = status.state === "HELD" ? status.stakeAmount : status.costPaid;
  return (
    <Card label="Refundable stake">
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
        <span
          data-stake-state={status.state}
          style={{
            padding: "4px 9px",
            borderRadius: 99,
            background: `${treatment.color}1a`,
            border: `1px solid ${treatment.color}55`,
            color: treatment.color,
            fontSize: 10,
            fontFamily: F.mono,
            fontWeight: 800,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          {treatment.label}
        </span>
        <span style={{fontSize: 16, fontWeight: 700, fontFamily: F.mono, color: C.text}}>
          {fmtEthShort(stake)}
        </span>
      </div>
      <p style={{marginTop: 8, fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        {treatment.copy}
      </p>
      {status.state !== "PROTOCOL" && status.state !== "UNKNOWN" && (
        <Field k="Slot index" v={`#${status.slotIndex}`} />
      )}
    </Card>
  );
}
