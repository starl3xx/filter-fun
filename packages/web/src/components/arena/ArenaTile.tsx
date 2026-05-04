"use client";

/// ArenaTile — single token tile (Epic 1.19, spec §19.6.1).
///
/// Composition (top → bottom):
///   1. Header        — avatar + ticker + status pill + rank
///   2. HP block      — big HP integer (font-display 800, ~32px) + HpBar
///                      gradient + floating-delta overlay slot
///   3. Mini-bars     — 5 spec-locked components (§6.6 labels):
///                      velocity, effectiveBuyers, stickyLiquidity,
///                      retention, holderConcentration. stickyLiquidity
///                      gets the §6.4.3 emphasis treatment (thicker bar +
///                      tooltip + soft-rug pulse on >10pp drop).
///   4. Footer        — holders · marketCap · time-since-last-trade ·
///                      BUY deeplink.
///
/// **Per-component bar bounds.** Each bar shows the token's component score
/// on a 0..100 scale (the raw score is `[0,1]`). When `cohortRanks` is
/// provided the consumer pre-computed the percentile-rank-within-cohort
/// per component; the tile then renders the percentile (0..100) instead so
/// the spec's "where does this token sit in this week's distribution"
/// framing reads correctly. Falling back to absolute score if cohortRanks
/// is omitted keeps the component renderable in tests / standalone use.
///
/// **stickyLiquidity emphasis.**
///   - Bar height 6px (vs 4px for the other four components).
///   - Tooltip: "Real liquidity that hasn't fled. Anti-rug signal."
///   - Soft-rug pulse animation when stickyLiquidity drops >10pp between
///     two updates (the consumer passes `softRugPulseSeq` keyed on the
///     drop event so the animation REPLAYS on each new soft-rug).

import {useEffect, useState} from "react";

import type {HpUpdate} from "@/hooks/arena/useHpUpdates";
import type {TokenResponse} from "@/lib/arena/api";
import {tradeTokenUrl} from "@/lib/arena/api";
import {fmtPctChange} from "@/lib/arena/format";
import {HP_MAX} from "@/lib/arena/hp";
import {
  HP_TILE_COMPONENT_COLORS,
  HP_TILE_KEYS_IN_ORDER,
  HP_LABELS,
  type HpTileKey,
} from "@/lib/arena/hpLabels";
import {fmtAgo, fmtNum, fmtUSD} from "@/lib/format";
import {C, F, stripDollar, tickerColor} from "@/lib/tokens";

import {FloatingHpDelta} from "./FloatingHpDelta";
import {STATUS_GRADIENT} from "./HpBar";
import {StatusBadge} from "./StatusBadge";

/// Fixed token supply — every FilterToken mints 1B at construction
/// (`packages/contracts/src/FilterFactory.sol#DEFAULT_INITIAL_SUPPLY`).
/// Surfacing supply on `/tokens` is an indexer follow-up; until then we
/// derive market cap client-side as `price × FIXED_SUPPLY` so the tile
/// footer renders a meaningful number rather than "—".
const FIXED_TOKEN_SUPPLY = 1_000_000_000;

/// Soft-rug threshold. A stickyLiquidity drop greater than this pp value
/// between two updates fires the rug-pulse animation on the bar. Spec
/// §6.4.3 calls out >10pp as the soft-rug warning band.
export const STICKY_LIQUIDITY_RUG_THRESHOLD_PP = 10;

/// stickyLiquidity tooltip copy. Pinned by regression test so any rewrite
/// surfaces as a deliberate change rather than drift.
export const STICKY_LIQUIDITY_TOOLTIP = "Real liquidity that hasn't fled. Anti-rug signal.";

export type CohortPercentiles = ReadonlyMap<string, Partial<Record<HpTileKey, number>>>;

export type ArenaTileProps = {
  token: TokenResponse;
  /// Live HP overlay for this token, if any (Epic 1.17c). Drives the
  /// floating-delta overlay + supplies `holderConcentration` (which the
  /// polled `/tokens` response doesn't yet surface — Epic 1.18 indexer
  /// follow-up).
  liveHp?: HpUpdate;
  /// Latest HP_UPDATED `computedAt` for this token. The tile uses it as a
  /// React `key` on the floating-delta wrapper so each new update remounts
  /// the element and the animation replays on successive frames.
  hpUpdateSeq?: number;
  /// Signed delta to render in the floating-delta overlay. Consumer
  /// computes this as `live.hp - prevHp` from the previous HP update.
  hpDelta?: number;
  /// Soft-rug pulse seq — bumps when stickyLiquidity dropped > the
  /// threshold between two updates. Used as a React `key` on the bar.
  softRugPulseSeq?: number;
  /// Pre-computed cohort percentiles per component. When supplied the bars
  /// render the percentile-rank-within-cohort (spec §19.6.1) instead of
  /// the raw score.
  cohortPercentiles?: CohortPercentiles;
  /// Tap handler — selecting a tile mirrors the row-click behaviour: the
  /// home page sets `selectedToken` and surfaces the detail panel.
  onSelect?: (address: `0x${string}`) => void;
  /// Whether this tile is the currently-selected token. Drives a cyan
  /// edge accent that mirrors the row view's selection treatment.
  isSelected?: boolean;
  /// Chain — drives the "BUY" deeplink target (Uniswap on mainnet, Basescan
  /// fallback on Sepolia).
  chain: "base" | "base-sepolia";
};

export function ArenaTile({
  token,
  liveHp,
  hpUpdateSeq,
  hpDelta,
  softRugPulseSeq,
  cohortPercentiles,
  onSelect,
  isSelected,
  chain,
}: ArenaTileProps) {
  const filtered = token.status === "FILTERED";
  const finalist = token.status === "FINALIST";

  // Polled `/tokens` carries 5 components today (no holderConcentration).
  // Read holderConcentration off the live HP overlay when present — the
  // indexer's HP_UPDATED frame already includes it. Falls back to 0 so
  // the bar still renders (faintly) before the first SSE frame arrives.
  const holderConcentration = liveHp?.components.holderConcentration ?? 0;
  const componentValues: Record<HpTileKey, number> = {
    velocity:            token.components.velocity,
    effectiveBuyers:     token.components.effectiveBuyers,
    stickyLiquidity:     token.components.stickyLiquidity,
    retention:           token.components.retention,
    holderConcentration,
  };

  const tradeLink = tradeTokenUrl(token.token, chain);
  const priceNum = Number(token.price);
  const hasPrice = Number.isFinite(priceNum) && priceNum > 0;
  const marketCap = hasPrice ? priceNum * FIXED_TOKEN_SUPPLY : null;

  return (
    <article
      data-tile-token={token.token}
      data-tile-status={token.status}
      aria-label={`${token.ticker} rank ${token.rank || "—"} status ${token.status.toLowerCase()} HP ${token.hp}`}
      className="ff-arena-tile"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        borderRadius: 14,
        // Filtered tiles are de-emphasized — muted palette per spec §19.6.1
        // ("opacity: 0.6 on the tile container") so they're still scannable
        // but visually subordinated to the surviving cohort.
        opacity: filtered ? 0.6 : 1,
        background: isSelected
          ? `linear-gradient(135deg, ${C.cyan}1f, transparent 70%), rgba(255,255,255,0.03)`
          : finalist
            ? `linear-gradient(135deg, ${C.yellow}14, transparent 70%), rgba(255,255,255,0.03)`
            : "rgba(255,255,255,0.03)",
        border: `1px solid ${isSelected ? C.cyan + "aa" : C.line}`,
        boxShadow: finalist && !filtered ? `0 0 24px ${C.yellow}1a` : "none",
        cursor: onSelect ? "pointer" : "default",
        // Rank reorders animate via CSS transform when consumer reorders the
        // grid items — spec calls for ~400ms ease-out. We declare the
        // transition here so the parent grid's flip-style reordering reads
        // smoothly without a JS animation library.
        transition: "transform 400ms ease-out, border-color 180ms ease, box-shadow 220ms ease, opacity 280ms ease",
      }}
      onClick={onSelect ? () => onSelect(token.token) : undefined}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(token.token);
              }
            }
          : undefined
      }
    >
      <Header token={token} />
      <HpBlock
        hp={token.hp}
        status={token.status}
        hpUpdateSeq={hpUpdateSeq}
        hpDelta={hpDelta}
      />
      <MiniBars
        values={componentValues}
        cohortPercentilesForToken={cohortPercentiles?.get(token.token.toLowerCase())}
        softRugPulseSeq={softRugPulseSeq}
      />
      <Footer
        holders={token.holders}
        marketCap={marketCap}
        liveHp={liveHp}
        tradeUrl={tradeLink.url}
        tradeLabel={tradeLink.label}
        priceChange24h={token.priceChange24h}
      />
    </article>
  );
}

// ============================================================ Header

function Header({token}: {token: TokenResponse}) {
  const noDollar = stripDollar(token.ticker);
  const finalist = token.status === "FINALIST";
  const displayRank = token.rank > 0 ? `#${token.rank}` : "—";
  return (
    <div style={{display: "flex", alignItems: "center", gap: 10}}>
      <div
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: tickerColor(noDollar),
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          fontWeight: 800,
          color: "#1a012a",
          fontFamily: F.display,
          boxShadow: finalist ? `0 0 10px ${tickerColor(noDollar)}aa` : "none",
          flexShrink: 0,
        }}
      >
        {noDollar.slice(0, 2)}
      </div>
      <div style={{flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2}}>
        <span
          style={{
            fontSize: 16,
            fontFamily: F.display,
            fontWeight: 800,
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {token.ticker}
        </span>
        <div style={{display: "flex", alignItems: "center", gap: 6}}>
          <StatusBadge status={token.status} compact />
        </div>
      </div>
      <span
        style={{
          fontSize: 14,
          fontFamily: F.mono,
          fontWeight: 800,
          color: token.status === "FINALIST" ? C.yellow : C.dim,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}
      >
        {displayRank}
      </span>
    </div>
  );
}

// ============================================================ HP block

function HpBlock({
  hp,
  status,
  hpUpdateSeq,
  hpDelta,
}: {
  hp: number;
  status: TokenResponse["status"];
  hpUpdateSeq?: number;
  hpDelta?: number;
}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 6, position: "relative"}}>
      <div style={{display: "flex", alignItems: "baseline", gap: 8, position: "relative"}}>
        <span
          style={{
            fontSize: 32,
            fontFamily: F.display,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: status === "FINALIST" ? C.yellow : C.text,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            textShadow: status === "FINALIST" ? `0 0 14px ${C.yellow}55` : undefined,
          }}
        >
          HP {hp.toLocaleString("en-US")}
        </span>
        {hpUpdateSeq != null && hpDelta != null && hpDelta !== 0 && (
          // Component-identity remount per bugbot Medium (PR #91, commit
          // 10c2dd2) — keying the wrapper component (not a bare span)
          // makes the unmount/mount on each successive HP_UPDATED frame
          // explicit at the React reconciler boundary. See `FloatingHpDelta`
          // module docstring for the animation lifecycle.
          <HpDeltaSlot key={`delta-${hpUpdateSeq}`} delta={hpDelta} />
        )}
      </div>
      <FullWidthHpBar hp={hp} status={status} />
    </div>
  );
}

/// Component-identity wrapper for the floating delta. Same pattern as
/// `RugBarSlot` — the parent keys this slot on the HP_UPDATED seq so a
/// fresh frame re-mounts the underlying `FloatingHpDelta` and its
/// CSS animation runs from t=0.
function HpDeltaSlot({delta}: {delta: number}) {
  return (
    <span
      data-hp-delta-slot="true"
      style={{position: "absolute", right: 0, top: 0}}
    >
      <FloatingHpDelta delta={delta} />
    </span>
  );
}

/// Full-width variant of the row view's `ArenaHpBar` — same status-driven
/// gradient (`STATUS_GRADIENT`, ARENA_SPEC §6.4.3) but the bar width follows
/// the tile column rather than the fixed 100px default. Reusing the row
/// component would have hard-coded a narrow bar that didn't fill the tile;
/// keeping the gradient map exported from `HpBar.tsx` keeps a single source
/// of truth for the status → [from, to] pairing.
function FullWidthHpBar({hp, status}: {hp: number; status: TokenResponse["status"]}) {
  const clamped = Math.max(0, Math.min(HP_MAX, hp));
  const fillPct = (clamped / HP_MAX) * 100;
  const [fromColor, toColor] = STATUS_GRADIENT[status];
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={HP_MAX}
      aria-valuenow={clamped}
      aria-label={`HP ${clamped} of ${HP_MAX}`}
      style={{
        position: "relative",
        width: "100%",
        height: 8,
        borderRadius: 99,
        background: "rgba(255,255,255,0.06)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          width: `${fillPct}%`,
          background: `linear-gradient(90deg, ${fromColor}, ${toColor})`,
          boxShadow: `0 0 8px ${fromColor}66`,
          transition: "width 320ms ease",
        }}
      />
    </div>
  );
}

// ============================================================ Mini-bars

function MiniBars({
  values,
  cohortPercentilesForToken,
  softRugPulseSeq,
}: {
  values: Record<HpTileKey, number>;
  cohortPercentilesForToken?: Partial<Record<HpTileKey, number>>;
  softRugPulseSeq?: number;
}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 6}}>
      {HP_TILE_KEYS_IN_ORDER.map((key) => (
        <MiniBarRow
          key={key}
          tileKey={key}
          rawScore={values[key]}
          percentile={cohortPercentilesForToken?.[key]}
          softRugPulseSeq={key === "stickyLiquidity" ? softRugPulseSeq : undefined}
        />
      ))}
    </div>
  );
}

function MiniBarRow({
  tileKey,
  rawScore,
  percentile,
  softRugPulseSeq,
}: {
  tileKey: HpTileKey;
  rawScore: number;
  percentile?: number;
  softRugPulseSeq?: number;
}) {
  const color = HP_TILE_COMPONENT_COLORS[tileKey];
  const label = HP_LABELS[tileKey];
  const emphasized = tileKey === "stickyLiquidity";
  // Use percentile when supplied (spec calls for percentile-rank-within-
  // cohort); otherwise fall back to the raw [0,1] score scaled to [0,100].
  const pct = Math.max(
    0,
    Math.min(
      100,
      Math.round(percentile != null ? percentile : rawScore * 100),
    ),
  );
  const barHeight = emphasized ? 6 : 4;
  return (
    <div
      data-component-key={tileKey}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 36px",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div style={{display: "flex", flexDirection: "column", gap: 3, minWidth: 0}}>
        <span
          style={{
            fontSize: 10,
            fontFamily: F.mono,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: emphasized ? color : C.dim,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={emphasized ? STICKY_LIQUIDITY_TOOLTIP : undefined}
          aria-label={emphasized ? STICKY_LIQUIDITY_TOOLTIP : undefined}
        >
          {label}
        </span>
        <RugBarSlot
          // Bugbot Medium (PR #91, commit 10c2dd2): keying a single inline
          // <span> raised concerns about whether React would reliably
          // unmount + remount it across versions. Routing the keyed
          // identity through a dedicated COMPONENT (not a raw element)
          // makes the reconcile contract explicit — when the key changes,
          // React unmounts the old `RugBarSlot` instance and mounts a
          // fresh one, which forces the entire DOM subtree to remount and
          // the CSS keyframe to replay from start. The component is
          // still the only piece of UI that owns the rug-pulse class +
          // the bar geometry, so this isn't a new abstraction layer —
          // just an explicit identity boundary for the key.
          key={emphasized && softRugPulseSeq != null ? `rug-${softRugPulseSeq}` : "rug-static"}
          tileKey={tileKey}
          emphasized={emphasized}
          pulsing={emphasized && softRugPulseSeq != null}
          height={barHeight}
          color={color}
          fillPct={pct}
        />
      </div>
      <span
        style={{
          fontFamily: F.mono,
          fontSize: 10,
          fontWeight: 700,
          color: emphasized ? color : C.text,
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
        }}
      >
        {pct}%
      </span>
    </div>
  );
}

/// Component-identity wrapper for the mini-bar. The parent `MiniBarRow`
/// keys this component on the rug-pulse seq so a fresh > 10pp drop
/// re-mounts the entire subtree — the soft-rug CSS keyframe runs once
/// per mount, and component-identity is the cleanest reconcile signal
/// React offers (unlike keying a bare span, which bugbot called out
/// as fragile in PR #91, commit 10c2dd2). The bar's geometry +
/// fill-percentage transition still happen here; only the alarm
/// animation depends on the remount.
function RugBarSlot({
  tileKey,
  emphasized,
  pulsing,
  height,
  color,
  fillPct,
}: {
  tileKey: HpTileKey;
  emphasized: boolean;
  pulsing: boolean;
  height: number;
  color: string;
  fillPct: number;
}) {
  return (
    <span
      data-component-bar={tileKey}
      data-component-emphasized={emphasized || undefined}
      className={pulsing ? "ff-arena-tile-rug-pulse" : undefined}
      style={{
        display: "block",
        position: "relative",
        height,
        borderRadius: 99,
        background: "rgba(255,255,255,0.06)",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          display: "block",
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: `${fillPct}%`,
          background: `linear-gradient(90deg, ${color}, ${color}aa)`,
          boxShadow: emphasized ? `0 0 6px ${color}55` : "none",
          transition: "width 320ms ease",
        }}
      />
    </span>
  );
}

// ============================================================ Footer

function Footer({
  holders,
  marketCap,
  liveHp,
  tradeUrl,
  tradeLabel,
  priceChange24h,
}: {
  holders: number;
  marketCap: number | null;
  liveHp?: HpUpdate;
  tradeUrl: string;
  tradeLabel: string;
  priceChange24h: number;
}) {
  // `lastTradeAt` is an indexer follow-up — `/tokens` doesn't surface it
  // yet. Best-effort approximation: time since the most recent HP_UPDATED
  // frame's computedAt (block-time of the last recompute, which is
  // strongly correlated with the most recent swap for SWAP-triggered
  // recomputes). Falls back to "—" until the indexer surfaces a real
  // last-trade timestamp.
  const tradeAge = useTimeSinceSeconds(liveHp?.computedAt);
  const change = priceChange24h;
  const hasChange = Number.isFinite(change) && change !== 0;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto auto 1fr auto",
        alignItems: "center",
        gap: 10,
        paddingTop: 8,
        borderTop: `1px solid ${C.lineSoft}`,
        fontFamily: F.mono,
        fontSize: 10,
        color: C.dim,
      }}
    >
      <FooterStat label="Holders" value={holders > 0 ? fmtNum(holders) : "—"} />
      <FooterStat
        label="Market cap"
        value={marketCap != null ? fmtUSD(marketCap) : "—"}
      />
      <FooterStat
        // Bugbot Low (PR #91, commit 96dcbeb): the slot is bivalent — it
        // shows the 24h percent-change when there's price movement,
        // otherwise falls through to "time since last trade" derived
        // from the last HP recompute. The label needs to flip with the
        // value so users don't read "24h: 3m" as a 24-hour duration.
        label={hasChange ? "24h" : "Last trade"}
        value={hasChange ? fmtPctChange(change) : tradeAge}
        valueColor={
          hasChange
            ? change >= 0
              ? C.green
              : C.red
            : undefined
        }
      />
      <a
        href={tradeUrl}
        target="_blank"
        rel="noopener noreferrer"
        // Opening the DEX with the token pre-selected is the only allowed
        // affordance per the dispatch — no in-tile swap widget. Stop click
        // propagation so the surrounding tile's onSelect doesn't ALSO fire
        // (which would race the new tab open).
        onClick={(e) => e.stopPropagation()}
        aria-label={tradeLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 10px",
          borderRadius: 99,
          background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`,
          color: "#fff",
          fontFamily: F.display,
          fontWeight: 800,
          fontSize: 11,
          letterSpacing: "0.06em",
          textDecoration: "none",
          boxShadow: `0 2px 10px ${C.pink}55`,
        }}
      >
        BUY ↗
      </a>
    </div>
  );
}

function FooterStat({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <span style={{display: "inline-flex", alignItems: "baseline", gap: 4, whiteSpace: "nowrap"}}>
      <span style={{color: C.faint, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase"}}>{label}</span>
      <span style={{color: valueColor ?? C.text, fontVariantNumeric: "tabular-nums", fontWeight: 700}}>{value}</span>
    </span>
  );
}

/// "Time since X" hook — re-renders the holder roughly every 15s so the
/// "1m ago" → "2m ago" transition reads correctly without a per-second
/// timer (which would re-render every tile every second). Returns "—"
/// when the timestamp is missing or in the future.
function useTimeSinceSeconds(unixSeconds: number | undefined): string {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!unixSeconds || unixSeconds > now) return "—";
  const delta = Math.max(0, now - unixSeconds);
  return fmtAgo(delta);
}
