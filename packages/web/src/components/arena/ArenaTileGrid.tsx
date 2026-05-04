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

import {useEffect, useMemo, useRef} from "react";

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
  // pass them in.
  //
  // **Reads in useMemo, writes in useEffect** — bugbot finding (PR #91,
  // commit ffaab21). The previous shape mutated refs during the render
  // body, which is broken under React StrictMode: `reactStrictMode: true`
  // in `next.config.mjs` double-invokes the render function, so the first
  // invoke wrote `prevSticky = current` and the second invoke read back
  // its own value, suppressing the floating-delta + rug-pulse on every
  // frame in dev (and producing inconsistent behaviour across React
  // versions in prod). The useEffect runs once after each commit, so by
  // the time the next render reads the refs they reflect the previously-
  // committed values exactly. The `useTileSortMeta` hook in `page.tsx`
  // uses the same read-render / write-effect split.
  const prevHpRef = useRef<Map<string, number>>(new Map());
  const softRugSeqRef = useRef<Map<string, {seq: number; prevSticky: number}>>(new Map());

  const renderEntries = useMemo(
    () =>
      tokens.map((t) => {
        const addr = t.token.toLowerCase();
        const live = hpByAddress.get(addr);
        const seq = freshHpUpdateSeqByAddress.get(addr);
        const prevHp = prevHpRef.current.get(addr);
        const hpDelta = seq != null && prevHp != null ? t.hp - prevHp : undefined;

        // Soft-rug detection. Compare *current* stickyLiquidity (from live
        // or polled) against the previous live frame's stickyLiquidity.
        // Bump the pulse seq when the drop > threshold. Stickiness arrives
        // on the [0,1] scale so multiply by 100 to compare in pp.
        //
        // **Pulse-seq stickiness across non-drop renders** — bugbot Medium
        // (PR #91, commit 278b16d). The class on the bar drives a 1.4s CSS
        // keyframe; the `RugBarSlot` keys on `softRugPulseSeq` so a fresh
        // drop forces a remount and replays the animation. The pre-fix
        // shape only set `softRugPulseSeq` on the single render that
        // detected the drop — on the very next render (a poll, an SSE
        // frame for an unrelated tile, anything that re-runs the memo)
        // the threshold check failed (prevSticky was already updated to
        // the post-drop value by the useEffect) so the seq reverted to
        // `undefined`, the key flipped from `rug-N` back to `rug-static`,
        // and the in-flight CSS animation got destroyed mid-pulse. The
        // fix: once `seq > 0` (i.e., a pulse has fired at least once for
        // this address), preserve that seq across non-drop renders so
        // the React key stays consistent and the keyframe runs to
        // completion. We deliberately gate on `seq > 0` — `seq === 0`
        // is the seed value; preserving it would re-introduce the
        // sub-threshold-drop bug from PR #91 round 1.
        const currentSticky = (live?.components.stickyLiquidity ?? t.components.stickyLiquidity) * 100;
        const rugRecord = softRugSeqRef.current.get(addr);
        let softRugPulseSeq: number | undefined;
        if (rugRecord && rugRecord.prevSticky - currentSticky > STICKY_LIQUIDITY_RUG_THRESHOLD_PP) {
          softRugPulseSeq = rugRecord.seq + 1;
        } else if (rugRecord && rugRecord.seq > 0) {
          softRugPulseSeq = rugRecord.seq;
        }

        return {
          token: t,
          live,
          seq,
          hpDelta,
          currentSticky,
          softRugPulseSeq,
        };
      }),
    [tokens, hpByAddress, freshHpUpdateSeqByAddress],
  );

  // Commit the previous values after the render commits — see ref
  // declaration for the StrictMode rationale.
  useEffect(() => {
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
  }, [renderEntries]);

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
  // Bugbot finding (PR #91, commit 2a5dce2): a single-token cohort can't
  // produce a meaningful percentile (you can't rank against yourself).
  // The pre-fix `denom = Math.max(1, n - 1)` collapsed N=1 to denom=1, the
  // single token got sort-index 0, and every bar rendered as `0 / 1 * 100`
  // = 0% — the tile looked empty even when the token had perfect scores.
  // Bail out for cohorts of 0 OR 1 so the tile's `MiniBarRow` falls
  // through to its `rawScore * 100` branch and renders the absolute score.
  if (tokens.length <= 1) return out;
  for (const t of tokens) out.set(t.token.toLowerCase(), {});

  const denom = tokens.length - 1;

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
