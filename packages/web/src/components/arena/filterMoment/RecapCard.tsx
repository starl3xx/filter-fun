"use client";

/// Post-filter recap (spec §21.4).
///
/// Center-screen card that lands ~5s after `FILTER_FIRED`. Mirrors the
/// spec example layout:
///
///   FILTER COMPLETE
///   $A $B $C $D $E $F        ← survivor tickers
///   Champion Pool +Ξ X.XX
///   [Your rollover sub-card if applicable]
///   [View Arena] button
///
/// The card has a deliberate auto-fade (30s, owned by `useFilterMoment`)
/// so screenshots are easy. Dismissal is explicit via the button or the
/// auto-timer; the backdrop click bubbles to the overlay.

import type {ReactNode} from "react";

import {Triangle} from "@/components/Triangle";
import type {SeasonResponse, TokenResponse} from "@/lib/arena/api";
import {fmtEth} from "@/lib/arena/format";
import {C, F, tickerColor} from "@/lib/tokens";

import {RolloverCard} from "./RolloverCard";

export type RecapCardProps = {
  /// Survivor cohort (rank 1..6). Pre-sorted by rank ascending — the card
  /// just renders left-to-right.
  survivors: TokenResponse[];
  /// Tickers the connected wallet held that were just filtered. Drives the
  /// rollover sub-card visibility.
  walletFilteredTickers: string[];
  /// Champion pool delta as a decimal-ether string. Animated in via CSS;
  /// the parent-level transition handles the count-up.
  championPoolDelta?: string;
  /// Current Champion Pool total — surfaced as the post-delta value.
  championPoolNow?: string;
  /// Projected wallet rollover entitlement — null until indexer ships.
  walletEntitlementEth: string | null;
  /// Season carrying the settlement anchor for the rollover sub-card.
  season: SeasonResponse | null;
  /// Imperative dismissal — button + Esc + backdrop all funnel here.
  onDismiss: () => void;
  /// Optional decoration for tests / Storybook to skip the entry animation.
  skipAnimation?: boolean;
};

export function RecapCard({
  survivors,
  walletFilteredTickers,
  championPoolDelta,
  championPoolNow,
  walletEntitlementEth,
  season,
  onDismiss,
  skipAnimation,
}: RecapCardProps) {
  const showDelta = championPoolDelta && Number(championPoolDelta) > 0;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Filter complete recap"
      className={skipAnimation ? undefined : "ff-filter-moment-recap"}
      style={{
        width: "min(92vw, 640px)",
        maxHeight: "min(86vh, 720px)",
        overflowY: "auto",
        background: `linear-gradient(180deg, ${C.bg2}f0, ${C.panel}f8)`,
        border: `1.5px solid ${C.line}`,
        borderRadius: 18,
        boxShadow: `0 16px 64px rgba(0, 0, 0, 0.6), 0 0 80px ${C.pink}33`,
        padding: "28px 28px 22px",
        color: C.text,
        backdropFilter: "blur(12px)",
        position: "relative",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <Header />

      <SurvivorRow survivors={survivors} />

      {showDelta ? (
        <PoolDelta delta={championPoolDelta!} now={championPoolNow} />
      ) : (
        <PoolDelta delta="0" now={championPoolNow} placeholder />
      )}

      <RolloverCard
        filteredTickers={walletFilteredTickers}
        entitlementEth={walletEntitlementEth}
        settlementAtIso={season?.finalSettlementAt}
      />

      <DismissButton onClick={onDismiss} />
    </div>
  );
}

// ============================================================ pieces

function Header() {
  return (
    <div style={{textAlign: "center", marginBottom: 18}}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          fontFamily: F.display,
          fontSize: "clamp(24px, 4vw, 36px)",
          fontWeight: 900,
          letterSpacing: "0.06em",
          color: C.text,
        }}
      >
        <Triangle size={22} inline />
        <span>FILTER COMPLETE</span>
        <Triangle size={22} inline />
      </div>
    </div>
  );
}

function SurvivorRow({survivors}: {survivors: TokenResponse[]}) {
  if (survivors.length === 0) {
    return (
      <div style={{textAlign: "center", color: C.faint, padding: "12px 0"}}>
        Awaiting survivor cohort…
      </div>
    );
  }
  return (
    <div
      aria-label="Survivors"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(survivors.length, 6)}, minmax(0, 1fr))`,
        gap: 10,
        margin: "0 auto 16px",
        maxWidth: 560,
      }}
      className="ff-filter-moment-survivors"
    >
      {survivors.slice(0, 6).map((t) => (
        <SurvivorTile key={t.token} token={t} />
      ))}
    </div>
  );
}

function SurvivorTile({token}: {token: TokenResponse}) {
  const sym = stripDollar(token.ticker);
  const color = tickerColor(sym);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "10px 6px",
        borderRadius: 10,
        background: "rgba(255, 233, 51, 0.08)",
        border: `1px solid ${C.yellow}55`,
        boxShadow: `0 0 18px ${C.yellow}33`,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: color,
          display: "grid",
          placeItems: "center",
          color: "#1a012a",
          fontWeight: 900,
          fontSize: 10,
          fontFamily: F.display,
        }}
      >
        {sym.slice(0, 2)}
      </div>
      <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 12, letterSpacing: "-0.01em"}}>{token.ticker}</div>
      <div style={{fontFamily: F.mono, fontWeight: 700, fontSize: 10, color: C.dim}}>HP {token.hp}</div>
    </div>
  );
}

function PoolDelta({delta, now, placeholder}: {delta: string; now?: string; placeholder?: boolean}) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "12px 0",
        borderTop: `1px solid ${C.line}`,
        borderBottom: `1px solid ${C.line}`,
        margin: "8px 0 4px",
      }}
    >
      <div style={{fontFamily: F.mono, fontSize: 9, color: C.faint, letterSpacing: "0.18em", fontWeight: 800, textTransform: "uppercase"}}>
        Champion Pool
      </div>
      <div
        style={{
          marginTop: 4,
          display: "inline-flex",
          alignItems: "baseline",
          gap: 10,
          fontFamily: F.mono,
          fontWeight: 800,
          color: C.yellow,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span style={{fontSize: 28, textShadow: `0 0 24px ${C.yellow}88`}}>
          {now ? fmtEth(now) : "Ξ —"}
        </span>
        {!placeholder && (
          <span className="ff-filter-moment-pool-delta" style={{fontSize: 16, color: C.green}}>
            +{fmtEth(delta)}
          </span>
        )}
      </div>
    </div>
  );
}

function DismissButton({onClick}: {onClick: () => void}): ReactNode {
  return (
    <div style={{marginTop: 18, display: "flex", justifyContent: "center"}}>
      <button
        type="button"
        onClick={onClick}
        autoFocus
        style={{
          padding: "10px 22px",
          borderRadius: 99,
          border: `1px solid ${C.cyan}aa`,
          background: `${C.cyan}1a`,
          color: C.cyan,
          fontFamily: F.mono,
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        View arena
      </button>
    </div>
  );
}

function stripDollar(t: string): string {
  return t.startsWith("$") ? t.slice(1) : t;
}
