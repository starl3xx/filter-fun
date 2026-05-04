"use client";

/// ArenaTileGrid — responsive 2/3-column tile wrapper (Epic 1.19).
///
/// Layout per breakpoint (CSS in globals.css):
///   - ≥1024px: 3-column grid
///   - 700..1024px: 2-column grid
///   - <700px: parent force-fallback to list view (this grid never renders)
///
/// The grid owns:
///   - **Cohort percentile rank computation.** For each component the bar
///     renders the percentile of THIS week's cohort (spec §19.6.1: "where
///     does this token sit in this week's distribution"). Computing it
///     once at the grid level means each tile doesn't redo the O(N²) sort.
///   - **HP-delta + soft-rug-pulse seq tracking.** Stores the previous HP
///     + stickyLiquidity per address in a ref; on each render derives the
///     delta to feed `FloatingHpDelta` and bumps a soft-rug seq when
///     stickyLiquidity dropped > the threshold.
///
/// **Why a ref for previous values rather than a `useReducer`.** A reducer
/// would cycle through every render and trigger re-renders just to update
/// the historical tracking. The ref approach keeps the previous-value
/// store invisible to React's render commit so updates don't fan out.

import {useMemo, useRef} from "react";

import type {HpUpdate} from "@/hooks/arena/useHpUpdates";
import type {TokenResponse} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

import type {CohortPercentiles} from "./ArenaTile";
import {ArenaTile, STICKY_LIQUIDITY_RUG_THRESHOLD_PP} from "./ArenaTile";
import {HP_TILE_KEYS_IN_ORDER, type HpTileKey} from "@/lib/arena/hpLabels";

export type ArenaTileGridProps = {
  /// Already sorted; the grid renders in order. The page applies the user's
  /// chosen sort upstream so the grid stays presentational.
  tokens: ReadonlyArray<TokenResponse>;
  /// Live HP overlay (Epic 1.17c). Provides holderConcentration + drives
  /// the floating-delta animation per tile.
  hpByAddress: ReadonlyMap<string, HpUpdate>;
  /// Address (lowercase) → recent HP_UPDATED computedAt within the recency
  /// window. Drives the floating-delta seq-key per tile so the animation
  /// replays on each successive update.
  freshHpUpdateSeqByAddress: ReadonlyMap<string, number>;
  selectedAddress: `0x${string}` | null;
  onSelect: (address: `0x${string}`) => void;
  chain: "base" | "base-sepolia";
};

export function ArenaTileGrid({
  tokens,
  hpByAddress,
  freshHpUpdateSeqByAddress,
  selectedAddress,
  onSelect,
  chain,
}: ArenaTileGridProps) {
  const cohortPercentiles = useMemo(() => computeCohortPercentiles(tokens, hpByAddress), [tokens, hpByAddress]);

  // Track previous HP + stickyLiquidity per address across renders so we
  // can derive delta + soft-rug-pulse seq without consumers having to
  // pass them in. Refs survive React StrictMode's double-invoke-mount
  // unscathed (no state writes).
  const prevHpRef = useRef<Map<string, number>>(new Map());
  const softRugSeqRef = useRef<Map<string, {seq: number; prevSticky: number}>>(new Map());

  const renderEntries = tokens.map((t) => {
    const addr = t.token.toLowerCase();
    const live = hpByAddress.get(addr);
    const seq = freshHpUpdateSeqByAddress.get(addr);
    const prevHp = prevHpRef.current.get(addr);
    const hpDelta = seq != null && prevHp != null ? t.hp - prevHp : undefined;

    // Soft-rug detection. Compare *current* stickyLiquidity (from live or
    // polled) against the previous live frame's stickyLiquidity. Bump the
    // pulse seq when the drop > threshold. Stickiness arrives on the
    // [0,1] scale so multiply by 100 to compare in pp.
    //
    // Note: `softRugPulseSeq` stays undefined unless the THIS render
    // detected a fresh drop — so a sub-threshold drift (e.g. 5pp) does
    // not light up the class on the bar. A previous fresh drop's pulse
    // ran on its own render commit; carrying the seq forward without a
    // new drop would mean every subsequent poll re-applied the class
    // even though nothing rugged this tick (regression test
    // `does NOT fire on a sub-threshold drop`).
    const currentSticky = (live?.components.stickyLiquidity ?? t.components.stickyLiquidity) * 100;
    const rugRecord = softRugSeqRef.current.get(addr);
    let softRugPulseSeq: number | undefined;
    if (rugRecord && rugRecord.prevSticky - currentSticky > STICKY_LIQUIDITY_RUG_THRESHOLD_PP) {
      softRugPulseSeq = rugRecord.seq + 1;
    }

    return {
      token: t,
      live,
      seq,
      hpDelta,
      currentSticky,
      softRugPulseSeq,
    };
  });

  // Commit the new previous values *after* all entries are derived.
  // Doing this in render is intentional — we want the next render to see
  // the values from THIS render. (A `useEffect` would defer the commit a
  // frame, which is enough for the next HP_UPDATED to read stale values
  // and miscompute the delta.)
  for (const e of renderEntries) {
    const addr = e.token.token.toLowerCase();
    prevHpRef.current.set(addr, e.token.hp);
    const cur = softRugSeqRef.current.get(addr);
    // Always overwrite prevSticky with the current value so the NEXT
    // render compares against today's reading (not the seed reading).
    // `seq` only advances when this render fired a fresh pulse.
    softRugSeqRef.current.set(addr, {
      seq: e.softRugPulseSeq ?? cur?.seq ?? 0,
      prevSticky: e.currentSticky,
    });
  }

  return (
    <section
      aria-label="Arena leaderboard tile view"
      className="ff-arena-tile-grid-section"
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
          <span aria-hidden>🏟️</span> Arena tiles
        </h2>
        <span
          style={{
            fontSize: 10,
            fontFamily: F.mono,
            color: C.dim,
            letterSpacing: "0.12em",
            fontWeight: 700,
          }}
        >
          {tokens.length} {tokens.length === 1 ? "TOKEN" : "TOKENS"}
        </span>
      </div>
      <div
        className="ff-arena-tile-grid"
        style={{
          padding: 16,
          gap: 16,
        }}
      >
        {tokens.length === 0 && (
          <div style={{padding: "32px 18px", textAlign: "center", color: C.faint, fontSize: 12, gridColumn: "1 / -1"}}>
            No tokens in the cohort yet — the next launch window will populate the arena.
          </div>
        )}
        {renderEntries.map((e) => (
          <ArenaTile
            key={e.token.token}
            token={e.token}
            liveHp={e.live}
            hpUpdateSeq={e.seq}
            hpDelta={e.hpDelta}
            softRugPulseSeq={e.softRugPulseSeq}
            cohortPercentiles={cohortPercentiles}
            isSelected={selectedAddress === e.token.token}
            onSelect={onSelect}
            chain={chain}
          />
        ))}
      </div>
    </section>
  );
}

/// Per-component percentile rank within the visible cohort. For each tile
/// component, sort the cohort by that component's score ascending and
/// assign each token a percentile = (its index / max-index) × 100.
///
/// `holderConcentration` only flows on the live HP overlay (the polled
/// `/tokens` doesn't carry it yet), so the cohort scan reads it from
/// `hpByAddress` when present and falls back to 0 — that pushes tokens
/// without live data to the bottom of that one component's percentile,
/// which is the right behaviour pre-SSE.
export function computeCohortPercentiles(
  tokens: ReadonlyArray<TokenResponse>,
  hpByAddress: ReadonlyMap<string, HpUpdate>,
): CohortPercentiles {
  const out = new Map<string, Partial<Record<HpTileKey, number>>>();
  if (tokens.length === 0) return out;
  for (const t of tokens) out.set(t.token.toLowerCase(), {});

  const denom = Math.max(1, tokens.length - 1);

  for (const key of HP_TILE_KEYS_IN_ORDER) {
    const sorted = [...tokens].sort((a, b) => scoreFor(a, key, hpByAddress) - scoreFor(b, key, hpByAddress));
    sorted.forEach((t, i) => {
      const slot = out.get(t.token.toLowerCase());
      if (slot) slot[key] = (i / denom) * 100;
    });
  }

  return out;
}

function scoreFor(t: TokenResponse, key: HpTileKey, hpByAddress: ReadonlyMap<string, HpUpdate>): number {
  if (key === "holderConcentration") {
    return hpByAddress.get(t.token.toLowerCase())?.components.holderConcentration ?? 0;
  }
  return t.components[key as keyof TokenResponse["components"]];
}
