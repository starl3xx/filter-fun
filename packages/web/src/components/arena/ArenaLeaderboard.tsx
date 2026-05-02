"use client";

/// Arena leaderboard (spec §19.6 + §19.7).
///
/// Center column. Renders the cohort sorted by ascending rank — top 6 are
/// emphasized (full opacity, finalist gold tint), the cut line pulses
/// between #6 and #7, and the bottom 6 are dimmed/red.
///
/// Selection lifts up: clicking a row calls `onSelect(token)` and the parent
/// (`/arena` page) keeps `selectedToken`. The detail panel reads the same
/// `tokens` array from cache to render its panel — no separate fetch.

import {memo, useMemo} from "react";

import {Triangle} from "@/components/Triangle";
import type {TokenResponse} from "@/lib/arena/api";
import {fmtPctChange} from "@/lib/arena/format";
import {fmtPrice} from "@/lib/format";
import {sparkPath} from "@/lib/sparkline";
import {C, F, stripDollar, tickerColor} from "@/lib/tokens";

import {ArenaHpBar} from "./HpBar";
import {StatusBadge} from "./StatusBadge";

export type ArenaLeaderboardProps = {
  tokens: TokenResponse[];
  /// Address → recent HP samples (from useTrendBuffers).
  trendBuffers: Map<`0x${string}`, number[]>;
  selectedAddress: `0x${string}` | null;
  onSelect: (address: `0x${string}`) => void;
  /// True during launch phase or before any finalize — suppresses the cut
  /// line because no cut is imminent.
  hideCutLine?: boolean;
  /// True when the leaderboard is empty (pre-season or no cohort yet).
  isLoading?: boolean;
  /// Pre-filter mode (Epic 1.9 / spec §21.2). Pulses the cut line at a
  /// faster cadence than the locked motion spec and shows an "AT RISK"
  /// danger chip on rows 5-8 (near the cut). Drives the leaderboard's
  /// share of the dramatic pre-roll without baking time into this layer.
  urgentCutline?: boolean;
  /// Firing mode (spec §21.3). Locks selection visually (rows still
  /// receive clicks) and stamps filtered rows with a red ▼ overlay +
  /// halos surviving rows in finalist gold for the duration. Truthy
  /// only during the ~5s firing stage.
  firingMode?: boolean;
  /// Addresses to mark as "just filtered" — drives the red ▼ stamp and
  /// the fade. Lower-case canonical (indexer form) comparison.
  recentlyFilteredAddresses?: Set<`0x${string}`>;
};

const COL_TEMPLATE = "32px 30px minmax(0, 1fr) 116px 92px 84px 78px 74px";
const CUT_INDEX = 6; // Cut line lives between rows[5] and rows[6] — i.e. between rank 6 and rank 7.

export const ArenaLeaderboard = memo(function ArenaLeaderboard({
  tokens,
  trendBuffers,
  selectedAddress,
  onSelect,
  hideCutLine,
  isLoading,
  urgentCutline,
  firingMode,
  recentlyFilteredAddresses,
}: ArenaLeaderboardProps) {
  const sorted = useMemo(() => sortByRank(tokens), [tokens]);
  const showCutLine = !hideCutLine && sorted.length > CUT_INDEX;
  const filteredLower = useMemo(() => {
    if (!recentlyFilteredAddresses) return null;
    return new Set(Array.from(recentlyFilteredAddresses).map((a) => a.toLowerCase()));
  }, [recentlyFilteredAddresses]);

  return (
    <section
      aria-label="Arena leaderboard"
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: 14,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${C.line}`,
        overflow: "hidden",
        minHeight: 0,
      }}
    >
      <Header total={sorted.length} />
      <div className="ff-scroll" style={{overflow: "auto"}}>
        <div style={{minWidth: 760}}>
          <ColumnHeader />
          {sorted.length === 0 && <EmptyState isLoading={isLoading ?? false} />}
          {sorted.map((t, i) => (
            <Row
              key={t.token}
              token={t}
              index={i}
              spark={trendBuffers.get(t.token) ?? []}
              isSelected={selectedAddress === t.token}
              below={i >= CUT_INDEX}
              onSelect={onSelect}
              urgentNearCut={!!urgentCutline && isNearCut(i)}
              firingMode={!!firingMode}
              filtered={firingMode && filteredLower ? filteredLower.has(t.token.toLowerCase()) : false}
              survivor={firingMode && filteredLower ? !filteredLower.has(t.token.toLowerCase()) && i < CUT_INDEX : false}
            />
          )).flatMap((row, i) => (showCutLine && i === CUT_INDEX ? [<CutLine key="cut" urgent={!!urgentCutline} />, row] : [row]))}
        </div>
      </div>
    </section>
  );
});

/// Rows 5..8 (zero-indexed 4..7) are the near-cut band — ranks 5, 6, 7, 8.
/// Drives the "AT RISK" chip during the pre-filter window per spec §21.2.
function isNearCut(indexInList: number): boolean {
  return indexInList >= 4 && indexInList <= 7;
}

// ============================================================ sorting

export function sortByRank(tokens: TokenResponse[]): TokenResponse[] {
  // The indexer pre-sorts but we re-sort defensively — a stale poll could
  // arrive out-of-order with a fresher one if requests interleave.
  return [...tokens].sort((a, b) => {
    if (a.rank === 0 && b.rank === 0) return a.token.localeCompare(b.token);
    if (a.rank === 0) return 1;
    if (b.rank === 0) return -1;
    return a.rank - b.rank;
  });
}

// ============================================================ pieces

function Header({total}: {total: number}) {
  return (
    <div
      style={{
        padding: "12px 18px",
        borderBottom: `1px solid ${C.line}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <h2 style={{margin: 0, fontWeight: 800, fontSize: 14, fontFamily: F.display}}>
        <span aria-hidden>🏟️</span> Arena leaderboard
      </h2>
      <span style={{fontSize: 10, fontFamily: F.mono, color: C.dim, letterSpacing: "0.12em", fontWeight: 700}}>
        {total} {total === 1 ? "TOKEN" : "TOKENS"}
      </span>
    </div>
  );
}

function ColumnHeader() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: COL_TEMPLATE,
        gap: 10,
        padding: "8px 18px",
        fontSize: 9,
        fontFamily: F.mono,
        color: C.faint,
        letterSpacing: "0.12em",
        fontWeight: 700,
        textTransform: "uppercase",
        position: "sticky",
        top: 0,
        zIndex: 1,
        background: C.panel,
        borderBottom: `1px solid ${C.lineSoft}`,
      }}
    >
      <div>#</div>
      <div></div>
      <div>Token</div>
      <div>HP</div>
      <div>Status</div>
      <div style={{textAlign: "right"}}>Price</div>
      <div style={{textAlign: "right"}}>24h</div>
      <div style={{textAlign: "right"}}>Trend</div>
    </div>
  );
}

function EmptyState({isLoading}: {isLoading: boolean}) {
  return (
    <div style={{padding: "32px 18px", textAlign: "center", color: C.faint, fontSize: 12}}>
      {isLoading ? "Loading cohort…" : "No tokens in the cohort yet — the next launch window will populate the arena."}
    </div>
  );
}

function CutLine({urgent}: {urgent?: boolean}) {
  return (
    <div
      role="separator"
      aria-label="Cut line — top 6 survive, bottom 6 get filtered"
      className={`ff-pulse ff-arena-cutline${urgent ? " ff-arena-cutline--urgent" : ""}`}
      style={{
        position: "relative",
        height: 36,
        background: `repeating-linear-gradient(45deg, ${C.red}38 0 8px, ${C.red}14 8px 16px)`,
        borderTop: `1.5px solid ${C.red}`,
        borderBottom: `1.5px solid ${C.red}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 18px",
        boxShadow: `0 0 28px ${C.red}88, inset 0 0 22px ${C.red}33`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "#1a012aee",
          padding: "5px 14px",
          borderRadius: 99,
          border: `1.5px solid ${C.red}`,
          boxShadow: `0 0 16px ${C.red}cc`,
        }}
      >
        <Triangle size={11} inline />
        <span style={{fontSize: 11, fontFamily: F.display, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", color: C.red}}>
          CUT LINE
        </span>
        <span style={{fontSize: 10, fontFamily: F.mono, color: C.dim}}>everything below gets filtered</span>
      </div>
    </div>
  );
}

function Row({
  token,
  index,
  spark,
  isSelected,
  below,
  onSelect,
  urgentNearCut,
  firingMode,
  filtered,
  survivor,
}: {
  token: TokenResponse;
  index: number;
  spark: number[];
  isSelected: boolean;
  below: boolean;
  onSelect: (a: `0x${string}`) => void;
  urgentNearCut?: boolean;
  firingMode?: boolean;
  filtered?: boolean;
  survivor?: boolean;
}) {
  const finalist = token.status === "FINALIST";
  const display = displayRank(token.rank, index);
  const priceNum = Number(token.price);
  const hasPrice = Number.isFinite(priceNum) && priceNum > 0;
  const hasChange = token.priceChange24h !== 0;
  const sparkColor = colorForChange(token.priceChange24h, token.hp);
  const ariaLabel = `${token.ticker} rank ${display} status ${token.status.toLowerCase()} HP ${token.hp}`;

  // Firing-mode treatments override the default below/finalist styling.
  // Filtered rows fade + get a red ▼ stamp (CSS class drives the timing
  // ramp); survivor rows in the top 6 get a brief gold halo.
  const rowOpacity = firingMode && filtered ? 0.42 : below ? 0.62 : 1;
  const rowClass = firingMode
    ? filtered
      ? "ff-arena-row-filtered"
      : survivor
        ? "ff-arena-row-survivor"
        : ""
    : "";
  const rowBackground = isSelected
    ? `linear-gradient(90deg, ${C.cyan}1a, transparent 70%)`
    : firingMode && survivor
      ? `linear-gradient(90deg, ${C.yellow}26, transparent 70%)`
      : finalist
        ? `linear-gradient(90deg, ${C.yellow}14, transparent 60%)`
        : "transparent";

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={isSelected}
      onClick={() => onSelect(token.token)}
      className={rowClass || undefined}
      style={{
        display: "grid",
        gridTemplateColumns: COL_TEMPLATE,
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "10px 18px",
        alignItems: "center",
        opacity: rowOpacity,
        background: rowBackground,
        // Neutralize the user-agent button border on top + right; keep the
        // bottom row separator and the left selection accent. Order matters
        // here — using `border: "none"` ahead of borderBottom/borderLeft
        // would have wiped them as the shorthand resets all four sides.
        borderTop: "none",
        borderRight: "none",
        borderBottom: `1px solid ${C.lineSoft}`,
        borderLeft: isSelected ? `2px solid ${C.cyan}` : "2px solid transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        position: "relative",
        transition: "opacity 0.6s ease, background 0.4s ease",
      }}
    >
      {firingMode && filtered && (
        <span
          aria-hidden
          className="ff-arena-row-filter-stamp"
          style={{
            position: "absolute",
            right: 22,
            top: "50%",
            transform: "translateY(-50%)",
            color: C.red,
            fontSize: 22,
            fontWeight: 900,
            textShadow: `0 0 14px ${C.red}cc`,
            pointerEvents: "none",
          }}
        >
          ▼
        </span>
      )}
      <div
        style={{
          fontFamily: display <= 3 ? F.display : F.mono,
          fontSize: display <= 3 ? 16 : 13,
          fontWeight: 800,
          color: display === 1 ? C.yellow : below ? C.faint : C.dim,
        }}
      >
        {display === 1 ? "🥇" : display === 2 ? "🥈" : display === 3 ? "🥉" : `#${display}`}
      </div>

      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: tickerColor(stripDollar(token.ticker)),
          display: "grid",
          placeItems: "center",
          fontSize: 9,
          fontWeight: 900,
          color: "#1a012a",
          fontFamily: F.display,
          boxShadow: finalist ? `0 0 10px ${tickerColor(stripDollar(token.ticker))}aa` : "none",
        }}
      >
        {stripDollar(token.ticker).slice(0, 2)}
      </div>

      <div style={{minWidth: 0, display: "flex", alignItems: "center", gap: 6}}>
        <span style={{fontSize: 13, fontWeight: 800, fontFamily: F.display, letterSpacing: "-0.01em"}}>{token.ticker}</span>
      </div>

      <ArenaHpBar hp={token.hp} status={token.status} dim={below} />

      <div style={{display: "flex", alignItems: "center", gap: 5, minWidth: 0}}>
        <StatusBadge status={token.status} compact />
        {urgentNearCut && !filtered && <AtRiskChip />}
      </div>

      <div
        style={{
          textAlign: "right",
          fontFamily: F.mono,
          fontSize: 12,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: hasPrice ? C.text : C.faint,
        }}
      >
        {hasPrice ? fmtPrice(priceNum) : "—"}
      </div>

      <div
        style={{
          textAlign: "right",
          fontFamily: F.mono,
          fontSize: 12,
          fontWeight: 800,
          color: !hasChange ? C.faint : token.priceChange24h >= 0 ? C.green : C.red,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {hasChange ? fmtPctChange(token.priceChange24h) : "—"}
      </div>

      <div style={{display: "flex", justifyContent: "flex-end"}}>
        <MiniSpark values={spark} color={sparkColor} />
      </div>
    </button>
  );
}

/// Pre-filter "AT RISK" danger chip (Epic 1.9 / spec §21.2). Shown next to
/// the regular status badge during the 10-minute urgent window for rows
/// near the cut. Distinct from the AT_RISK *status* badge (which is a
/// scoring-derived state) — this chip is a temporal warning, "the cut is
/// imminent and you're in the danger band."
function AtRiskChip() {
  return (
    <span
      data-chip="at-risk"
      className="ff-arena-row-at-risk-chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "1px 6px",
        borderRadius: 99,
        background: `${C.red}1f`,
        border: `1px solid ${C.red}cc`,
        color: C.red,
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: 8,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>▼</span>
      AT RISK
    </span>
  );
}

function MiniSpark({values, color}: {values: number[]; color: string}) {
  const w = 70;
  const h = 22;
  if (values.length < 2) {
    return (
      <svg width={w} height={h} aria-hidden>
        <line x1={2} y1={h / 2} x2={w - 2} y2={h / 2} stroke={C.faint} strokeWidth={1} strokeDasharray="2 3" />
      </svg>
    );
  }
  const path = sparkPath(values, w, h);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{display: "block"}}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function colorForChange(change: number, hp: number): string {
  if (change > 0) return C.green;
  if (change < 0) return C.red;
  if (hp >= 50) return C.dim;
  return C.faint;
}

/// Display rank: prefer the indexer's `rank` (1-based), fall back to the
/// row index when rank is 0 (unscored tokens still get a stable position).
function displayRank(rank: number, indexInList: number): number {
  return rank > 0 ? rank : indexInList + 1;
}

// Re-export for tests + consumers — keeps the cut-index contract explicit.
export {CUT_INDEX};
