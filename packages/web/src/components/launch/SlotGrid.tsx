"use client";

/// 12-card slot grid (spec §4.5 + §18.4).
///
/// Filled cards show ticker + creator + HP + status badge.
/// The first empty card highlights as "claim now" — that's the slot the
/// next valid launch will occupy.
/// Slots 9-11 carry an "Almost gone" badge.
/// Closed-window slots (window expired or cap reached) render dimmed.

import {memo} from "react";

import type {LaunchSlot} from "@/hooks/launch/useLaunchSlots";
import {ArenaHpBar} from "@/components/arena/HpBar";
import {StatusBadge} from "@/components/arena/StatusBadge";
import {C, F, stripDollar, tickerColor} from "@/lib/tokens";
import {fmtEthFromWei, shortAddr} from "@/lib/launch/format";

export type SlotGridProps = {
  slots: LaunchSlot[];
  /// Slot index the user has chosen (defaults to the next-empty index).
  /// Selection is informational — only one slot is actually claimable
  /// (the one the contract will route the next launch to).
  selectedSlot?: number;
  onSelectSlot?: (slotIndex: number) => void;
};

export const SlotGrid = memo(function SlotGrid({slots, onSelectSlot}: SlotGridProps) {
  return (
    <section
      aria-label="Week launch slots"
      style={{
        borderRadius: 14,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.03)",
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontFamily: F.display,
            fontWeight: 800,
            fontSize: 14,
          }}
        >
          📅 Week launch slots
        </h2>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 99,
            border: `1px solid ${C.green}55`,
            background: `${C.green}1a`,
            color: C.green,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 9,
            letterSpacing: "0.16em",
          }}
        >
          ● LIVE
        </span>
      </div>
      <div
        style={{
          fontSize: 10,
          fontFamily: F.mono,
          color: C.faint,
          letterSpacing: "0.12em",
          fontWeight: 700,
          textTransform: "uppercase",
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span>HP = velocity + buyers + liquidity + retention</span>
        <span style={{marginLeft: "auto", display: "flex", gap: 12, color: C.dim}}>
          <span>👑 finalist</span>
          <span>✓ safe</span>
          <span style={{color: C.red}}>▼ at risk</span>
        </span>
      </div>
      <div className="ff-launch-slot-grid">
        {slots.map((slot) => (
          <SlotCard key={slot.slotIndex} slot={slot} onSelect={onSelectSlot} />
        ))}
      </div>
    </section>
  );
});

function SlotCard({slot, onSelect}: {slot: LaunchSlot; onSelect?: (i: number) => void}) {
  const slotLabel = `Slot ${String(slot.slotIndex + 1).padStart(2, "0")}`;
  switch (slot.kind) {
    case "filled":
    case "filled-pending":
      return <FilledCard slot={slot} slotLabel={slotLabel} />;
    case "reserved-pending":
    case "reserved-refund-pending":
      return <ReservedCard slot={slot} slotLabel={slotLabel} />;
    case "next":
      return <ClaimNowCard slot={slot} slotLabel={slotLabel} onSelect={onSelect} />;
    case "almost":
      return <EmptyCard slot={slot} slotLabel={slotLabel} variant="almost" onSelect={onSelect} />;
    case "open":
      return <EmptyCard slot={slot} slotLabel={slotLabel} variant="open" onSelect={onSelect} />;
    case "closed":
      return <EmptyCard slot={slot} slotLabel={slotLabel} variant="closed" />;
  }
}

/// Epic 1.15c — slot reserved but not yet launched. The reservation lives in
/// `LaunchEscrow` until either (a) the season activates and `launchProtocolToken`
/// normalises it into a launched token, or (b) the season aborts and the
/// reservation is refunded. REFUND_PENDING surfaces a stronger warning hue
/// (creator must call `claimPendingRefund` to drain the pending-refund slot).
function ReservedCard({slot, slotLabel}: {slot: LaunchSlot; slotLabel: string}) {
  const isRefundPending = slot.kind === "reserved-refund-pending";
  const accent = isRefundPending ? C.yellow : C.cyan;
  const label = isRefundPending ? "REFUND PENDING" : "RESERVED";
  const escrowEth =
    slot.reservation?.escrowAmountWei !== undefined
      ? fmtEthFromWei(slot.reservation.escrowAmountWei)
      : null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        border: `1px dashed ${accent}88`,
        background: `linear-gradient(135deg, ${accent}14, transparent 70%)`,
        opacity: isRefundPending ? 0.85 : 1,
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <span
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {slotLabel}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 99,
            border: `1px solid ${accent}66`,
            background: `${accent}1a`,
            color: accent,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 9,
            letterSpacing: "0.16em",
          }}
        >
          {label}
        </span>
      </div>
      <div style={{display: "flex", alignItems: "center", gap: 10, minHeight: 36}}>
        <div style={{minWidth: 0}}>
          <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 13, lineHeight: 1.1}}>
            {isRefundPending ? "Awaiting refund claim" : "Pending activation"}
          </div>
          <div style={{fontSize: 10, color: C.dim, fontFamily: F.mono, marginTop: 2}}>
            by {slot.creator ? shortAddr(slot.creator) : "—"}
          </div>
        </div>
      </div>
      {escrowEth !== null && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            color: C.dim,
            fontFamily: F.mono,
          }}
        >
          <span>escrow</span>
          <span>{escrowEth} ETH</span>
        </div>
      )}
    </div>
  );
}

function FilledCard({slot, slotLabel}: {slot: LaunchSlot; slotLabel: string}) {
  const t = slot.cohortEntry;
  const ticker = t?.ticker ?? "$…";
  const stripped = stripDollar(ticker);
  const status = t?.status ?? "SAFE";
  const hp = t?.hp ?? 0;
  const finalist = status === "FINALIST";
  const filtered = status === "FILTERED";

  return (
    <a
      href={t ? `/?token=${t.token}` : "/"}
      style={{
        textDecoration: "none",
        color: "inherit",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        border: `1px solid ${finalist ? C.yellow + "55" : filtered ? C.red + "44" : C.line}`,
        background: finalist
          ? "linear-gradient(135deg, rgba(255,233,51,0.08), transparent 70%)"
          : "rgba(255,255,255,0.03)",
        boxShadow: finalist ? `0 0 18px ${C.yellow}33` : "none",
        opacity: filtered ? 0.7 : 1,
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <span
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {slotLabel}
        </span>
        <StatusBadge status={status} compact />
      </div>
      <div style={{display: "flex", alignItems: "center", gap: 10}}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 7,
            background: tickerColor(stripped),
            display: "grid",
            placeItems: "center",
            fontSize: 11,
            fontWeight: 800,
            color: "#1a012a",
            fontFamily: F.display,
            boxShadow: finalist ? `0 0 10px ${tickerColor(stripped)}aa` : "none",
          }}
        >
          {stripped.slice(0, 2)}
        </div>
        <div style={{minWidth: 0}}>
          <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 14, lineHeight: 1.1}}>{ticker}</div>
          {t && (
            <div style={{fontSize: 10, color: C.dim, fontFamily: F.mono, marginTop: 2}}>
              {t.ticker.replace(/^\$/, "")}
            </div>
          )}
        </div>
      </div>
      <div style={{display: "flex", alignItems: "center", gap: 8}}>
        <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700}}>
          HP
        </span>
        <ArenaHpBar hp={hp} />
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 11,
            fontWeight: 800,
            color: C.text,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {hp}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: C.dim,
          fontFamily: F.mono,
        }}
      >
        <span>by {slot.creator ? shortAddr(slot.creator) : "—"}</span>
        {slot.kind === "filled-pending" && (
          <span style={{color: C.cyan}}>indexing…</span>
        )}
      </div>
    </a>
  );
}

function ClaimNowCard({
  slot,
  slotLabel,
  onSelect,
}: {
  slot: LaunchSlot;
  slotLabel: string;
  onSelect?: (i: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(slot.slotIndex)}
      className="ff-launch-claim-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        border: `1.5px dashed ${C.pink}`,
        background:
          "linear-gradient(135deg, rgba(255,58,161,0.18), rgba(156,92,255,0.12) 60%, transparent)",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
        boxShadow: `0 0 18px ${C.pink}33`,
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <span
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.cyan,
            letterSpacing: "0.16em",
            fontWeight: 800,
            textTransform: "uppercase",
          }}
        >
          {slotLabel}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 99,
            border: `1px solid ${C.cyan}55`,
            background: `${C.cyan}1a`,
            color: C.cyan,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 9,
            letterSpacing: "0.16em",
          }}
        >
          ◆ OPEN
        </span>
      </div>
      <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 22}}>Claim now</div>
      <div style={{fontSize: 11, color: C.dim}}>You're up next.</div>
      <div
        style={{
          marginTop: "auto",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700}}>
          COST
        </span>
        <span
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 16,
            color: C.text,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtEthFromWei(slot.costWei)}
        </span>
      </div>
    </button>
  );
}

function EmptyCard({
  slot,
  slotLabel,
  variant,
  onSelect,
}: {
  slot: LaunchSlot;
  slotLabel: string;
  variant: "almost" | "open" | "closed";
  onSelect?: (i: number) => void;
}) {
  const closed = variant === "closed";
  const almost = variant === "almost";
  const stripeColor = almost ? C.yellow : C.line;
  const interactive = !closed && onSelect !== undefined;
  const Tag = (interactive ? "button" : "div") as "button" | "div";

  return (
    <Tag
      type={interactive ? "button" : undefined}
      onClick={interactive ? () => onSelect?.(slot.slotIndex) : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        border: `1.5px dashed ${stripeColor}`,
        background: closed ? "rgba(255,255,255,0.02)" : "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: interactive ? "pointer" : "default",
        opacity: closed ? 0.55 : 1,
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <span
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {slotLabel}
        </span>
        {almost && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              borderRadius: 99,
              border: `1px solid ${C.yellow}55`,
              background: `${C.yellow}1a`,
              color: C.yellow,
              fontFamily: F.mono,
              fontWeight: 800,
              fontSize: 9,
              letterSpacing: "0.16em",
            }}
          >
            🔥 HOT
          </span>
        )}
        {closed && (
          <span
            style={{
              fontFamily: F.mono,
              fontWeight: 800,
              fontSize: 9,
              letterSpacing: "0.16em",
              color: C.faint,
            }}
          >
            CLOSED
          </span>
        )}
      </div>
      <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 18}}>
        {closed ? "Closed" : almost ? "Almost gone" : "Open"}
      </div>
      <div style={{fontSize: 11, color: C.dim}}>
        {closed ? "Waiting on next season" : "Available to launch"}
      </div>
      <div
        style={{
          marginTop: "auto",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700}}>
          COST
        </span>
        <span
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 14,
            color: closed ? C.faint : C.dim,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtEthFromWei(slot.costWei)}
        </span>
      </div>
    </Tag>
  );
}

