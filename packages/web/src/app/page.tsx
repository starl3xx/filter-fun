"use client";

/// `/` — the main spectator surface (Epic 1.4 + 1.8 web).
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
///
/// Historical note: the homepage previously rendered a placeholder broadcast
/// design backed by simulation hooks (`useLiveTokens`, `usePOLStats`, etc.).
/// That layout is gone; the arena IS the homepage. `/arena` redirects here
/// (see `next.config.mjs`) so external links and muscle-memory still resolve.

import {useEffect, useMemo, useRef, useState} from "react";
import {useAccount} from "wagmi";

import {ArenaActivityFeed} from "@/components/arena/ArenaActivityFeed";
import {ArenaFilterMechanic} from "@/components/arena/ArenaFilterMechanic";
import {ArenaLeaderboard} from "@/components/arena/ArenaLeaderboard";
import {ArenaSortDropdown, useArenaSortMode, useSortedTileTokens} from "@/components/arena/ArenaSortDropdown";
import {ArenaTicker} from "@/components/arena/ArenaTicker";
import {ArenaTileGrid} from "@/components/arena/ArenaTileGrid";
import {ArenaTokenDetail} from "@/components/arena/ArenaTokenDetail";
import {ArenaTopBar} from "@/components/arena/ArenaTopBar";
import {FilterMomentOverlay} from "@/components/arena/filterMoment/FilterMomentOverlay";
import {useArenaViewMode, ViewToggle} from "@/components/arena/ViewToggle";
import {DataErrorBanner} from "@/components/DataErrorBanner";
import {Stars} from "@/components/Stars";
import {useFilterMoment} from "@/hooks/arena/useFilterMoment";
import {freshHpUpdateSeqByAddress, type HpUpdate, mergeHpUpdates, useHpUpdates} from "@/hooks/arena/useHpUpdates";
import {useSeason} from "@/hooks/arena/useSeason";
import {useTickerEvents} from "@/hooks/arena/useTickerEvents";
import {useTokens} from "@/hooks/arena/useTokens";
import {useTrendBuffers} from "@/hooks/arena/useTrendBuffers";
import type {SeasonResponse, TokenResponse} from "@/lib/arena/api";
import {fmtEth} from "@/lib/arena/format";
import {C, F} from "@/lib/tokens";

export default function HomePage() {
  const {data: season, error: seasonError} = useSeason();
  const {data: tokens, isLoading: tokensLoading, error: tokensError} = useTokens();
  const {events, status: liveStatus} = useTickerEvents();
  // Phase 1 audit C-5 (2026-05-01): the polling hooks capture fetch errors in
  // state but the page previously dropped them silently. We surface a single
  // non-blocking banner whenever EITHER /season or /tokens is failing — the
  // grid still renders with stale-or-empty data underneath, so users can see
  // the prior cohort while we explain why it isn't refreshing. The banner
  // auto-clears the moment the next poll succeeds (`error` resets to null).
  const dataError = tokensError ?? seasonError ?? null;
  const trendBuffers = useTrendBuffers(tokens);

  // Memoize the empty-fallback so `cohort` keeps a stable identity while
  // `tokens` is null — without this the auto-select / drop-stale effects
  // below see a fresh `[]` reference on every render and fire each cycle
  // (no state is set, but the effect runs unnecessarily during the loading
  // phase before the first /tokens response arrives).
  const polledCohort = useMemo(() => tokens ?? [], [tokens]);

  // Epic 1.17c — overlay the freshest HP_UPDATED frames from the SSE stream
  // onto the polled cohort. The polled `/tokens` response is the source of
  // truth for rank/status/prices; live HP only re-paints the bar + components.
  // Merging here (above any consumer) means the leaderboard, the detail
  // panel, and the trend buffers all see the same coherent view.
  const {hpByAddress} = useHpUpdates(events);
  const cohort = useMemo(() => mergeHpUpdates(polledCohort, hpByAddress), [polledCohort, hpByAddress]);
  // Per-address sequence ids drive the row-level pulse. The leaderboard
  // uses each token's seq as a React `key` on the HP-bar wrapper so the
  // CSS animation replays on each successive update — a Set-based
  // "is-fresh" flag would leave the className unchanged across consecutive
  // updates within the same recency window, suppressing the second pulse.
  const freshHpSeq = useMemo(() => freshHpUpdateSeqByAddress(hpByAddress, 3_000), [hpByAddress]);

  // ============================================================ Epic 1.19
  // View mode + tile sort (persisted in localStorage). The toggle hides on
  // mobile via CSS, but a user who saved "tile" then resized down would
  // still trigger the tile path — `isNarrow` below force-falls back to
  // list at <700px so the small-screen layout is always coherent.
  //
  // `tileSortMeta` + `tileSorted` are gated on `tileGridActive` (computed
  // alongside `firingMode` further down) so list/mobile/firing-mode users
  // don't pay the per-cohort iteration + ref-tracking cost. Bugbot Low
  // (PR #91, commit 10c2dd2). Hooks themselves still call every render
  // (Rules of Hooks); the gate short-circuits the body.
  const [viewMode, setViewMode] = useArenaViewMode();
  const [sortMode, setSortMode] = useArenaSortMode();
  const isNarrow = useIsNarrow();
  const effectiveViewMode = isNarrow ? "list" : viewMode;

  const [selected, setSelected] = useState<`0x${string}` | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // /launch redirects here with `?token=0x…` after a successful launch so the
  // creator lands on their freshly-minted token. Read the param via
  // `window.location` (rather than `useSearchParams`) so the page can stay
  // statically prerendered without a Suspense boundary.
  const [tokenParam, setTokenParam] = useState<`0x${string}` | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = new URLSearchParams(window.location.search).get("token");
    if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) setTokenParam(v as `0x${string}`);
  }, []);

  // Auto-select rank-1 (or first non-zero rank) so the panel is always populated.
  // Always store the cohort entry's `token` (the canonical address form the
  // indexer publishes — lowercase) into `selected`. The drop-stale effect
  // below compares with `===`; if we stored the URL's form (which can be
  // checksummed / mixed-case) the next render's drop-stale would clear
  // selection because the strict equality fails, which would re-trigger
  // this effect, causing an infinite setState loop and a "Maximum update
  // depth exceeded" crash.
  useEffect(() => {
    if (selected) return;
    if (tokenParam) {
      const match = cohort.find((t) => t.token.toLowerCase() === tokenParam.toLowerCase());
      if (match) {
        setSelected(match.token);
        return;
      }
    }
    const first = cohort.find((t) => t.rank > 0) ?? cohort[0];
    if (first) setSelected(first.token);
  }, [cohort, selected, tokenParam]);

  // If the selected token is no longer in the cohort (filtered + dropped),
  // clear selection so the next render auto-picks rank-1. Strict equality
  // is safe because the auto-select above always stores the cohort entry's
  // own address — see commentary there.
  useEffect(() => {
    if (!selected) return;
    if (!cohort.find((t) => t.token === selected)) setSelected(null);
  }, [cohort, selected]);

  // Audit M-Ux-3 (Phase 1, 2026-05-03): sync the selected token to a
  // `?token=0x…` query param so a refresh or share-link preserves the
  // user's selection. Pre-fix only the inbound direction was wired
  // (post-launch redirect lands here with `?token=…` and `tokenParam`
  // picks it up via the auto-select effect above) — outbound was
  // missing, so a click on a different row would silently desync the
  // URL from the visible state and reset on refresh.
  //
  // Use `window.history.replaceState` rather than `router.replace`
  // because:
  //   1. We don't want a new history entry per click (back-button
  //      should NOT replay the user's selection trail).
  //   2. `router.replace` would re-run the page's data fetches; we
  //      only want to update the URL bar, not re-render anything.
  //
  // Skip during SSR (window guard) and skip when selected is null —
  // the cleared state should leave the URL alone rather than blanking
  // it (e.g. cleared by the drop-stale effect above on a filter event).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!selected) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("token")?.toLowerCase() === selected.toLowerCase()) return;
    url.searchParams.set("token", selected);
    window.history.replaceState({}, "", url.toString());
  }, [selected]);

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

  // ============================================================ Filter-moment

  // Pass `cohort` so `?simulate=filter` can synthesize a believable
  // filtered set (bottom 6) during dev — production reads /events for
  // real FILTER_FIRED data and ignores the cohort arg.
  const filterMoment = useFilterMoment({season: season ?? null, events, cohort});

  // Snapshots for the recap. The cohort + season can mutate after the
  // FILTER_FIRED event lands (the indexer drops filtered tokens from
  // /tokens, the championPool ticks up). The recap card needs the
  // *pre-firing* values to render survivors and a meaningful pool delta.
  // Latch a snapshot the first time the firing stage activates and clear
  // it once the overlay returns to idle.
  const cohortAtFiringRef = useRef<TokenResponse[] | null>(null);
  const seasonAtFiringRef = useRef<SeasonResponse | null>(null);
  useEffect(() => {
    if (filterMoment.stage === "firing" || filterMoment.stage === "recap") {
      if (cohortAtFiringRef.current === null && cohort.length > 0) {
        cohortAtFiringRef.current = cohort;
      }
      if (seasonAtFiringRef.current === null && season) {
        seasonAtFiringRef.current = season;
      }
    } else {
      // Clear snapshots whenever we're outside firing/recap — including
      // `done` and `countdown` (the next week's pre-roll). The hook can
      // transition done → countdown directly without passing through
      // idle if the next cut is already inside the 10-minute window;
      // bugbot caught the original idle-only branch leaving the stale
      // pre-firing snapshot in place, which would have been re-used by
      // the next cycle's firing stage. The next firing event re-latches
      // a fresh snapshot from the live cohort/season anyway, but only
      // because the refs are null at that point.
      cohortAtFiringRef.current = null;
      seasonAtFiringRef.current = null;
    }
  }, [filterMoment.stage, cohort, season]);

  const cohortSnapshot = cohortAtFiringRef.current ?? cohort;
  const seasonSnapshot = seasonAtFiringRef.current ?? season ?? null;
  const championPoolDelta = useMemo(() => {
    if (!season || !seasonSnapshot) return "0";
    const before = Number(seasonSnapshot.championPool ?? "0");
    const now = Number(season.championPool ?? "0");
    if (!Number.isFinite(before) || !Number.isFinite(now)) return "0";
    return Math.max(0, now - before).toFixed(2);
  }, [season, seasonSnapshot]);

  // Connected wallet → tickers it held that just got filtered. Until the
  // indexer ships the wallet × filtered-tokens projection endpoint, we can
  // surface the *tickers* (we know which tokens were filtered, but not
  // whether the wallet held them). The rollover-card is therefore best-
  // effort: when wagmi reports no connection, it stays hidden; when it
  // reports a connection but we lack holdings data, we render the card
  // with placeholder entitlement and a bookmark for follow-up indexer
  // work. See the indexer follow-up file in the PR description.
  const {address: walletAddress, isConnected} = useAccount();
  const walletFilteredTickers: string[] = useMemo(() => {
    if (!isConnected || !walletAddress) return [];
    if (filterMoment.filteredAddresses.size === 0) return [];
    // TODO(indexer follow-up): replace with `/wallets/{address}/holdings`
    // once it ships. Today we have no per-wallet holdings on the indexer's
    // public surface, so the card stays neutral — the parent treats an
    // empty list as "no rollover sub-card to show". Keeping the wiring in
    // place means the indexer work is a one-line swap.
    return [];
  }, [isConnected, walletAddress, filterMoment.filteredAddresses]);

  // Pre-filter-window flag drives the leaderboard's urgent cut line + AT
  // RISK chip. Both the hook's `countdown` stage and the broader
  // `isOverlayActive` flag during firing keep the visuals coherent. We
  // intentionally do NOT carry the urgent treatment into recap — by then
  // the cut has fired and the dramatic emphasis sits on the recap card.
  const urgentCutline = filterMoment.stage === "countdown";
  const firingMode = filterMoment.stage === "firing" || filterMoment.stage === "recap";

  // Tile grid active iff the page will actually render it — same condition
  // the JSX below uses. Drives both the sort-hook gate (Bugbot Low) and
  // the dropdown gate.
  const tileGridActive = effectiveViewMode === "tile" && !firingMode;
  const tileSortMeta = useTileSortMeta(cohort, hpByAddress, tileGridActive);
  const tileSorted = useSortedTileTokens(cohort, sortMode, tileSortMeta, tileGridActive);

  return (
    <div style={{position: "relative", minHeight: "100vh", overflow: "hidden"}}>
      <Stars />
      <ArenaTopBar season={season} liveStatus={liveStatus} />
      <ArenaTicker events={events} season={season} />
      {dataError && <DataErrorBanner error={dataError} />}

      <main className="ff-arena-grid" style={{position: "relative", zIndex: 1}}>
        <div className="ff-arena-col-left" style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          <ArenaFilterMechanic />
          <PoolsCard season={season} />
        </div>

        <div className="ff-arena-col-center" style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          {/* Epic 1.19 — view-mode toggle + (when in tile mode) sort dropdown.
              The toggle hides via CSS on mobile so users on a phone don't see
              an unreachable affordance; the `effectiveViewMode` JS gate
              forces list view at <700px regardless of the persisted choice. */}
          <div
            className="ff-arena-view-controls"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 10,
            }}
          >
            {/* Bugbot finding (PR #91, commit d787b88): the sort dropdown
                only meaningfully controls the tile grid, so its render
                gate has to mirror the SAME condition the tile grid uses
                below — `effectiveViewMode === "tile"` AND `!firingMode`.
                During filter-moment firing/recap the bottom branch falls
                back to the row layout regardless of the user's view-mode
                preference; without the firingMode exclusion here the
                user briefly saw a stranded sort dropdown above a list
                view it can't sort. */}
            {tileGridActive && (
              <ArenaSortDropdown value={sortMode} onChange={setSortMode} />
            )}
            <ViewToggle value={viewMode} onChange={setViewMode} />
          </div>
          {effectiveViewMode === "list" || firingMode ? (
            // Filter-moment firing animations only target the row layout; in
            // tile mode we fall back to the row view during the firing /
            // recap stages so the recap card's drama isn't lost. Once the
            // overlay returns to idle the user's preferred view restores.
            <ArenaLeaderboard
              tokens={firingMode ? cohortSnapshot : cohort}
              trendBuffers={trendBuffers}
              selectedAddress={selected}
              onSelect={onSelect}
              hideCutLine={hideCutLine}
              isLoading={tokensLoading}
              urgentCutline={urgentCutline}
              firingMode={firingMode}
              recentlyFilteredAddresses={filterMoment.filteredAddresses}
              freshHpUpdateSeqByAddress={firingMode ? undefined : freshHpSeq}
            />
          ) : (
            <ArenaTileGrid
              tokens={tileSorted}
              hpByAddress={hpByAddress}
              freshHpUpdateSeqByAddress={freshHpSeq}
              selectedAddress={selected}
              onSelect={onSelect}
              chain={chain}
            />
          )}
          <ArenaActivityFeed events={events} liveStatus={liveStatus} />
        </div>

        <div className="ff-arena-col-right" style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          <ArenaTokenDetail token={selectedToken} trend={selectedTrend} season={season} chain={chain} />
        </div>
      </main>

      {/* Filter-moment overlay (Epic 1.9). Stays out of the DOM in `idle` /
          `done`; otherwise composes the countdown / firing / recap stages on
          top of the live arena. */}
      <FilterMomentOverlay
        stage={filterMoment.stage}
        cohortSnapshot={cohortSnapshot}
        filteredAddresses={filterMoment.filteredAddresses}
        walletFilteredTickers={walletFilteredTickers}
        walletEntitlementEth={null}
        championPoolDelta={championPoolDelta}
        championPoolNow={season?.championPool ?? "0"}
        secondsUntilCut={filterMoment.secondsUntilCut}
        season={seasonSnapshot}
        onDismiss={filterMoment.dismiss}
      />

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

/// `useIsNarrow` — Epic 1.19 mobile force-fallback gate.
///
/// matchMedia (max-width: 700px). SSR-safe (returns false until mount),
/// listens for resize so a user dragging the window across the breakpoint
/// flips views without a refresh.
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 700px)");
    const onChange = () => setNarrow(mq.matches);
    onChange();
    // Older Safari versions exposed `addListener` not `addEventListener`;
    // this codebase already polyfills the older API in its setup tests, so
    // we use the modern path here without a fallback.
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/// `useTileSortMeta` — derives the {computedAt, prevHp} map the tile sort
/// dropdown's "activity" / "delta" modes consume. Tracks previous HP per
/// address in a ref across renders so the next render's delta-comparator
/// can compute |hp - prev|. Updates the ref AFTER deriving the map, so a
/// fresh poll's HP becomes the next render's "previous".
///
/// **`enabled` short-circuit** — bugbot finding (PR #91, commit 10c2dd2):
/// when the tile grid isn't rendered (list mode, mobile force-list, or
/// firing/recap stage), we skip both the per-cohort iteration AND the
/// post-commit ref-write effect. Rules of Hooks force us to KEEP calling
/// the hook every render, but the body short-circuits with an empty map
/// + skipped effect when the consumer isn't going to read the result.
const EMPTY_TILE_SORT_META: ReadonlyMap<string, {computedAt: number; prevHp: number}> = new Map();
function useTileSortMeta(
  cohort: ReadonlyArray<TokenResponse>,
  hpByAddress: ReadonlyMap<string, HpUpdate>,
  enabled: boolean = true,
): ReadonlyMap<string, {computedAt: number; prevHp: number}> {
  const prevRef = useRef<Map<string, number>>(new Map());
  const meta = useMemo(() => {
    if (!enabled) return EMPTY_TILE_SORT_META;
    const m = new Map<string, {computedAt: number; prevHp: number}>();
    for (const t of cohort) {
      const key = t.token.toLowerCase();
      const live = hpByAddress.get(key);
      const prev = prevRef.current.get(key) ?? t.hp;
      m.set(key, {
        computedAt: live?.computedAt ?? 0,
        prevHp: prev,
      });
    }
    return m;
    // We DON'T include prevRef.current in the deps — refs aren't reactive
    // by design, and including them would either re-fire every render or
    // produce stale closures.
  }, [cohort, hpByAddress, enabled]);

  // Commit current HP into the ref so next render's `prevHp` reflects it.
  // Skip when disabled — there's no consumer reading the meta, so spending
  // O(N) per cohort change to track a value nobody reads is wasted work.
  useEffect(() => {
    if (!enabled) return;
    for (const t of cohort) prevRef.current.set(t.token.toLowerCase(), t.hp);
  }, [cohort, enabled]);

  return meta;
}

/// Small "pools at a glance" card — repeats the top bar's pool figures with
/// the spec §19.5 framing copy. Sits in the left column on desktop so the
/// emotional center (cut line) and the prize pool are both always visible.
function PoolsCard({season}: {season: ReturnType<typeof useSeason>["data"]}) {
  return (
    <section aria-label="Prize pools" style={{borderRadius: 14, border: `1px solid ${C.line}`, background: "rgba(255,255,255,0.03)", padding: 14, display: "flex", flexDirection: "column", gap: 10}}>
      <div>
        <div style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", fontWeight: 700, textTransform: "uppercase"}}>Champion Pool ▼</div>
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
