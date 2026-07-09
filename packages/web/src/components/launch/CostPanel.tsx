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
///   │  • Filter Fund Liquidity Reserve (~Ξ X LP)   │
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
  /// Audit M-Ux-4 (Phase 1, 2026-05-03): true while the launcher status
  /// read (`getLaunchStatus`) is in flight. Pre-fix, the panel rendered
  /// `Ξ 0.0000  ($0)` during the loading window because launchCostWei
  /// fell back to 0n — visually indistinguishable from a free launch.
  /// When true, the cost cells render dashes (—) instead of the zero
  /// values, so the user sees "data is loading" rather than "data says
  /// zero." The earnings block stays visible because it doesn't depend
  /// on the cost values.
  costLoading?: boolean;
  /// Epic 2.6 (spec §47.3.8): true when the user armed the launch page's
  /// "Use Filter Club credit" toggle. Per the M-Ux-4 rationale above, a
  /// zero total is visually indistinguishable from a free launch — so a
  /// DELIBERATE free launch must be loudly labeled: the slot cost renders
  /// struck-through, a "FREE — Filter Club credit" badge sits beside it,
  /// and the total commits to Ξ 0 with an explicit credit note. The
  /// loading-dash discipline still wins while `costLoading` is true (the
  /// struck-through value would be a lying zero during the read).
  creditApplied?: boolean;
};

export function CostPanel({
  slotIndex,
  launchCostWei,
  stakeWei,
  ethUsd,
  championPoolEth,
  costLoading = false,
  creditApplied = false,
}: CostPanelProps) {
  const total = launchCostWei + stakeWei;
  const stakeOn = stakeWei > 0n;
  // A credit launch sends `value: 0n` — the contract retains no cost and no
  // stake (FilterLauncher.reserve step 8), so the committed total is exactly
  // zero. `free` gates the loud FREE rendering; while loading we still dash.
  const free = creditApplied && !costLoading;

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
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap"}}>
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
        {creditApplied && (
          <span
            data-testid="cost-panel-credit-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              borderRadius: 99,
              border: `1px solid ${C.yellow}66`,
              background: `${C.yellow}1a`,
              color: C.yellow,
              fontFamily: F.mono,
              fontWeight: 800,
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            FREE — Filter Club credit
          </span>
        )}
      </div>

      <Row
        label="Launch cost"
        eth={costLoading ? "—" : fmtEthFromWei(launchCostWei)}
        usd={costLoading ? "—" : fmtUsd(launchUsd)}
        struck={free}
      />
      {/* During load we don't yet know if stake mode is on (the read is
          gated behind the same status). Show the row with dashes so the
          panel layout is stable; if stake turns out to be off the row
          will disappear after the read resolves — that's preferable to
          either hiding it (layout shift on resolve) or rendering zero
          (false-precision). */}
      {(stakeOn || costLoading) && (
        <Row
          label="Refundable stake"
          eth={costLoading ? "—" : fmtEthFromWei(stakeWei)}
          usd={costLoading ? "—" : fmtUsd(stakeUsd)}
          struck={free}
        />
      )}

      <div style={{height: 1, background: C.line}} />
      <Row
        label="Total committed"
        eth={costLoading ? "—" : free ? fmtEthFromWei(0n) : fmtEthFromWei(total)}
        usd={costLoading ? "—" : free ? fmtUsd(0) : fmtUsd(totalUsd)}
        bold
      />

      {free && (
        <p
          data-testid="cost-panel-credit-note"
          style={{
            margin: 0,
            fontSize: 11,
            color: C.yellow,
            lineHeight: 1.45,
          }}
        >
          Your Filter Club credit covers this slot — no ETH leaves your wallet. The credit is
          consumed on-chain when the reservation lands.
        </p>
      )}

      {stakeOn && !free && (
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
          `Filter Fund Liquidity Reserve — ~${fmtEth4(polEthMid)} locked LP forever, compounding your token's liquidity`,
        ]}
      />
    </div>
  );
}

/// `struck` (Epic 2.6): renders the value cells with a line-through + faint
/// color — the "what you would have paid" state when a Filter Club credit
/// covers the launch. Label stays un-struck so the row remains scannable.
function Row({label, eth, usd, bold, struck}: {label: string; eth: string; usd: string; bold?: boolean; struck?: boolean}) {
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
          textDecoration: struck ? "line-through" : undefined,
        }}
      >
        <span
          style={{
            fontWeight: 800,
            fontSize: bold ? 16 : 13,
            color: struck ? C.faint : C.text,
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
