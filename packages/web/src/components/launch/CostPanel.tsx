"use client";

/// Cost & earnings panel for /launch (spec §18.5 + §45.2). Shows the static
/// cost breakdown that is always visible on the launch page — the
/// interactive calculator (RoiCalculator) layers on top of these baseline
/// numbers with user-supplied scenario inputs.
///
///   ┌─ Cost & Earnings ───────────────────────────┐
///   │ Slot N launch cost          Ξ 0.0XX  ($XX)  │
///   │ Refundable stake            Ξ 0.0XX  ($XX)  │
///   │ ───────────────────────────                  │
///   │ Total committed             Ξ 0.0XX  ($XX)  │
///   │                                              │
///   │ While live, you earn:                        │
///   │  • 0.20% of all trading volume               │
///   │                                              │
///   │ If your token wins the week:                 │
///   │  • 2.5% champion bounty (typical Ξ X – Ξ X)  │
///   │  • Permanent POL backing (~Ξ X locked LP)    │
///   └──────────────────────────────────────────────┘

import {C, F} from "@/lib/tokens";
import {fmtEthFromWei} from "@/lib/launch/format";
import {
  CHAMPION_BOUNTY_BPS,
  POL_SLICE_BPS,
  fmtEth4,
  fmtUsd,
  weiToUsd,
} from "@/lib/launch/economics";

export type CostPanelProps = {
  slotIndex: number;
  launchCostWei: bigint;
  /// Stake amount (matches launchCost when refundableStakeEnabled). 0 if
  /// stake mode is off — the panel hides the row in that case.
  stakeWei: bigint;
  /// ETH/USD rate. Optional — falls back to ETH_USD_FALLBACK when omitted.
  ethUsd?: number;
  /// Current champion pool (decimal-ETH string from the indexer's /season
  /// endpoint). Drives the "typical bounty" range. Falls back to a quiet-
  /// week heuristic when null/undefined so the panel still has copy.
  championPoolEth?: number | null;
};

export function CostPanel({
  slotIndex,
  launchCostWei,
  stakeWei,
  ethUsd,
  championPoolEth,
}: CostPanelProps) {
  const total = launchCostWei + stakeWei;
  const stakeOn = stakeWei > 0n;

  const launchUsd = weiToUsd(launchCostWei, ethUsd);
  const stakeUsd = weiToUsd(stakeWei, ethUsd);
  const totalUsd = weiToUsd(total, ethUsd);

  // Champion bounty range: derive from current pool size if we have it,
  // otherwise show a wide "typical week" placeholder so the panel doesn't
  // mislead before the indexer read lands. The pool grows through the
  // week, so multiplying the current value by ~3× gives a reasonable
  // upper bound for end-of-week settlement.
  const bountyShare = CHAMPION_BOUNTY_BPS / 10_000;
  const polShare = POL_SLICE_BPS / 10_000;
  const haveLivePool = typeof championPoolEth === "number" && championPoolEth > 0;
  const lowPoolEth = haveLivePool ? championPoolEth! : 4;
  const highPoolEth = haveLivePool ? championPoolEth! * 3 : 40;
  const bountyLowEth = lowPoolEth * bountyShare;
  const bountyHighEth = highPoolEth * bountyShare;
  const polEthMid = ((lowPoolEth + highPoolEth) / 2) * polShare;

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
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
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
          Cost &amp; earnings · Slot #{String(slotIndex + 1).padStart(2, "0")}
        </span>
      </div>

      <Row label="Launch cost" eth={fmtEthFromWei(launchCostWei)} usd={fmtUsd(launchUsd)} />
      {stakeOn && (
        <Row label="Refundable stake" eth={fmtEthFromWei(stakeWei)} usd={fmtUsd(stakeUsd)} />
      )}

      <div style={{height: 1, background: C.line}} />
      <Row label="Total committed" eth={fmtEthFromWei(total)} usd={fmtUsd(totalUsd)} bold />

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

      <div style={{height: 1, background: C.lineSoft, marginTop: 4}} />

      <EarningsBlock
        title="While live, you earn"
        accent={C.green}
        items={["0.20% of all trading volume on your token (paid in WETH)"]}
      />

      <EarningsBlock
        title="If your token wins the week"
        accent={C.yellow}
        items={[
          `2.5% champion bounty — typical ${fmtEth4(bountyLowEth)} – ${fmtEth4(bountyHighEth)}`,
          `Permanent POL backing — ~${fmtEth4(polEthMid)} locked LP forever`,
        ]}
      />
    </div>
  );
}

function Row({label, eth, usd, bold}: {label: string; eth: string; usd: string; bold?: boolean}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8}}>
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
          display: "inline-flex",
          alignItems: "baseline",
          gap: 8,
          fontFamily: F.mono,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span
          style={{
            fontWeight: 800,
            fontSize: bold ? 16 : 13,
            color: C.text,
          }}
        >
          {eth}
        </span>
        <span
          style={{
            fontSize: bold ? 12 : 11,
            color: C.faint,
            fontWeight: 600,
          }}
        >
          {usd}
        </span>
      </span>
    </div>
  );
}

function EarningsBlock({
  title,
  accent,
  items,
}: {
  title: string;
  accent: string;
  items: string[];
}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 4}}>
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 9,
          letterSpacing: "0.16em",
          fontWeight: 800,
          color: accent,
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      <ul style={{margin: 0, paddingLeft: 16, fontSize: 11, color: C.text, lineHeight: 1.55}}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
