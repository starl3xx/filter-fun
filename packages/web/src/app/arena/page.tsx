"use client";

/// /arena — the main spectator surface (Epic 1.4 + 1.8 web).
///
/// Polls `/season` and `/tokens` and subscribes to `/events`. Selection state
/// is local to this page; the detail panel reads from the same `tokens`
/// array the leaderboard renders, so there's no second fetch.
///
/// Layout:
///
///   ┌─────────────────────────────────────────────────────────────┐
///   │ TopBar (LIVE · Week · Next cut · Champion · Backing)        │
///   ├─────────────────────────────────────────────────────────────┤
///   │ Ticker (5-state SSE marquee)                                │
///   ├──────────────┬───────────────────────┬──────────────────────┤
///   │ Filter info  │ Leaderboard + cut     │ Token detail         │
///   │              │ line                  │                      │
///   │              │                       │                      │
///   ├──────────────┴───────────────────────┴──────────────────────┤
///   │ Activity feed                                               │
///   └─────────────────────────────────────────────────────────────┘
///
/// Below 1100px: single column, leaderboard above detail.
/// Below 700px: detail collapses to a bottom-sheet on row tap.

import {useEffect, useMemo, useState} from "react";

import {ArenaActivityFeed} from "@/components/arena/ArenaActivityFeed";
import {ArenaFilterMechanic} from "@/components/arena/ArenaFilterMechanic";
import {ArenaLeaderboard} from "@/components/arena/ArenaLeaderboard";
import {ArenaTicker} from "@/components/arena/ArenaTicker";
import {ArenaTokenDetail} from "@/components/arena/ArenaTokenDetail";
import {ArenaTopBar} from "@/components/arena/ArenaTopBar";
import {useSeason} from "@/hooks/arena/useSeason";
import {useTickerEvents} from "@/hooks/arena/useTickerEvents";
import {useTokens} from "@/hooks/arena/useTokens";
import {useTrendBuffers} from "@/hooks/arena/useTrendBuffers";
import {Stars} from "@/components/broadcast/Stars";
import {fmtEth} from "@/lib/arena/format";
import {C, F} from "@/lib/tokens";

export default function ArenaPage() {
  const {data: season} = useSeason();
  const {data: tokens, isLoading: tokensLoading} = useTokens();
  const {events, status: liveStatus} = useTickerEvents();
  const trendBuffers = useTrendBuffers(tokens);

  // Memoize the empty-fallback so `cohort` keeps a stable identity while
  // `tokens` is null — without this the auto-select / drop-stale effects
  // below see a fresh `[]` reference on every render and fire each cycle
  // (no state is set, but the effect runs unnecessarily during the loading
  // phase before the first /tokens response arrives).
  const cohort = useMemo(() => tokens ?? [], [tokens]);
  const [selected, setSelected] = useState<`0x${string}` | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Auto-select rank-1 (or first non-zero rank) so the panel is always populated.
  useEffect(() => {
    if (selected) return;
    const first = cohort.find((t) => t.rank > 0) ?? cohort[0];
    if (first) setSelected(first.token);
  }, [cohort, selected]);

  // If the selected token is no longer in the cohort (filtered + dropped),
  // clear selection so the next render auto-picks rank-1.
  useEffect(() => {
    if (!selected) return;
    if (!cohort.find((t) => t.token === selected)) setSelected(null);
  }, [cohort, selected]);

  const selectedToken = useMemo(() => cohort.find((t) => t.token === selected) ?? null, [cohort, selected]);
  const selectedTrend = selected ? trendBuffers.get(selected) ?? [] : [];

  const chain = (process.env.NEXT_PUBLIC_CHAIN === "base" ? "base" : "base-sepolia") as "base" | "base-sepolia";
  // Hide cut line in launch phase: status mapping treats everyone as SAFE
  // there, so showing a cut would be misleading.
  const hideCutLine = season?.phase === "launch";

  const onSelect = (addr: `0x${string}`) => {
    setSelected(addr);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches) {
      setSheetOpen(true);
    }
  };

  return (
    <div style={{position: "relative", minHeight: "100vh", overflow: "hidden"}}>
      <Stars />
      <ArenaTopBar season={season} liveStatus={liveStatus} />
      <ArenaTicker events={events} season={season} />

      <main className="ff-arena-grid" style={{position: "relative", zIndex: 1}}>
        <div className="ff-arena-col-left" style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          <ArenaFilterMechanic />
          <PoolsCard season={season} />
        </div>

        <div className="ff-arena-col-center" style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          <ArenaLeaderboard
            tokens={cohort}
            trendBuffers={trendBuffers}
            selectedAddress={selected}
            onSelect={onSelect}
            hideCutLine={hideCutLine}
            isLoading={tokensLoading}
          />
          <ArenaActivityFeed events={events} />
        </div>

        <div className="ff-arena-col-right" style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          <ArenaTokenDetail token={selectedToken} trend={selectedTrend} season={season} chain={chain} />
        </div>
      </main>

      {/* Mobile bottom-sheet for token detail. Only renders below 700px via the
          parent's media-query gate; on wider viewports the right column is shown
          inline so the sheet is unused. */}
      {sheetOpen && selectedToken && (
        <div className="ff-arena-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="ff-arena-sheet" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              aria-label="Close detail"
              onClick={() => setSheetOpen(false)}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                width: 30,
                height: 30,
                background: "rgba(255,255,255,0.06)",
                border: "none",
                borderRadius: 99,
                color: C.text,
                fontSize: 18,
                cursor: "pointer",
              }}
            >
              ×
            </button>
            <ArenaTokenDetail token={selectedToken} trend={selectedTrend} season={season} chain={chain} />
          </div>
        </div>
      )}
    </div>
  );
}

/// Small "pools at a glance" card — repeats the top bar's pool figures with
/// the spec §19.5 framing copy. Sits in the left column on desktop so the
/// emotional center (cut line) and the prize pool are both always visible.
function PoolsCard({season}: {season: ReturnType<typeof useSeason>["data"]}) {
  return (
    <section aria-label="Prize pools" style={{borderRadius: 14, border: `1px solid ${C.line}`, background: "rgba(255,255,255,0.03)", padding: 14, display: "flex", flexDirection: "column", gap: 10}}>
      <div>
        <div style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700, textTransform: "uppercase"}}>Champion Pool 🔻</div>
        <div style={{fontSize: 22, fontFamily: F.mono, fontWeight: 800, color: C.yellow, fontVariantNumeric: "tabular-nums"}}>
          {season ? fmtEth(season.championPool) : "Ξ —"}
        </div>
        <div style={{fontSize: 10, color: C.dim, marginTop: 2}}>Winner takes everything.</div>
      </div>
      <div>
        <div style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700, textTransform: "uppercase"}}>Champion Backing</div>
        <div style={{fontSize: 22, fontFamily: F.mono, fontWeight: 800, color: C.cyan, fontVariantNumeric: "tabular-nums"}}>
          {season ? fmtEth(season.polReserve) : "Ξ —"}
        </div>
        <div style={{fontSize: 10, color: C.dim, marginTop: 2}}>Protocol backing for the winner.</div>
      </div>
    </section>
  );
}
