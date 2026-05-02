"use client";

/// Personal rollover-entitlement card (spec §21.4 + §33.2).
///
/// Rendered inside `RecapCard` only when the connected wallet held tokens
/// that just got filtered. Surfaces:
///
///   - The list of filtered tickers the wallet held.
///   - A projected rollover entitlement (placeholder until the indexer
///     ships the wallet × filtered → projected ETH endpoint).
///   - A claim-when-settled note pointing at Sunday 00:00 UTC.
///
/// Contract:
///   The hook → page wires the projected entitlement once it lands. Until
///   then, `entitlementEth = null` renders a `~Ξ ?` placeholder so the
///   card remains visually complete and the recap layout doesn't shift
///   when the indexer follow-up ships.
///
/// Copy stays neutral broadcast — no "you got filtered!" — per the brief.

import {Triangle} from "@/components/Triangle";
import {fmtEth} from "@/lib/arena/format";
import {C, F} from "@/lib/tokens";

export type RolloverCardProps = {
  /// Tickers the connected wallet held that were just filtered. Already
  /// `$`-prefixed.
  filteredTickers: string[];
  /// Decimal-ether projected rollover entitlement, or null if the
  /// indexer hasn't surfaced this number yet (placeholder).
  entitlementEth: string | null;
  /// Ticker the rollover lands in (the future winner). Empty until
  /// finals + settlement; rendered as "the winner" in the meantime.
  winnerTicker?: string;
  /// ISO timestamp of finalSettlementAt. Rendered as "Sunday 00:00 UTC"
  /// so the user has both wall-clock and weekly anchor.
  settlementAtIso?: string;
};

export function RolloverCard({filteredTickers, entitlementEth, winnerTicker, settlementAtIso}: RolloverCardProps) {
  if (filteredTickers.length === 0) return null;
  const tickersDisplay = filteredTickers.join(", ");
  const eth = entitlementEth ? fmtEth(entitlementEth) : "~Ξ ?";

  return (
    <section
      aria-label="Your rollover"
      style={{
        marginTop: 18,
        padding: "14px 16px",
        background: "rgba(0, 240, 255, 0.06)",
        border: `1px solid ${C.cyan}55`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: "0.18em",
          color: C.cyan,
          textTransform: "uppercase",
        }}
      >
        Your rollover
      </div>

      <div style={{fontSize: 13, color: C.text}}>
        <span style={{color: C.dim}}>Tokens filtered: </span>
        <span style={{fontFamily: F.mono, fontWeight: 700}}>{tickersDisplay}</span>
      </div>

      <div style={{display: "flex", alignItems: "baseline", gap: 8}}>
        <span style={{fontSize: 13, color: C.dim}}>Rollover entitlement:</span>
        <span
          className="ff-filter-moment-rollover-pulse"
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 18,
            color: C.cyan,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {eth}
        </span>
        {winnerTicker ? (
          <span style={{fontSize: 12, color: C.dim}}>in {winnerTicker}</span>
        ) : (
          <span style={{fontSize: 12, color: C.faint}}>in winner</span>
        )}
        <Triangle size={12} inline />
      </div>

      <div style={{fontSize: 11, color: C.faint, fontFamily: F.mono, letterSpacing: "0.04em"}}>
        Claim available after settlement{settlementAtIso ? ` (${formatSettlement(settlementAtIso)})` : ""}.
      </div>
    </section>
  );
}

/// Format the finalSettlementAt as a friendly anchor: "Sunday 00:00 UTC".
/// Falls back to the bare "00:00 UTC" if Intl ever throws.
function formatSettlement(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "Sunday 00:00 UTC";
    const day = d.toLocaleDateString("en-US", {weekday: "long", timeZone: "UTC"});
    const time = d.toLocaleTimeString("en-US", {hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"});
    return `${day} ${time} UTC`;
  } catch {
    return "Sunday 00:00 UTC";
  }
}
