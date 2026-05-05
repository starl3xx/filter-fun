"use client";

/// `/graveyard` — Epic 1.25 (spec §7.3 / §36.1.2).
///
/// Cross-season archive of every filtered token. Drives the "see who got
/// filtered" spectator surface. Default sort is most-recent filter first;
/// hero strip surfaces the closest near-misses across all seasons.

import {useEffect, useMemo, useState} from "react";
import Link from "next/link";

import {C, F} from "@/lib/tokens";
import {
  fetchGraveyard,
  type GraveyardResponse,
  type GraveyardSort,
  type GraveyardTokenRow,
} from "@/lib/arena/api";
import {shortAddr} from "@/lib/launch/format";

import {NearMissChip} from "@/components/graveyard/NearMissChip";

type FetchState =
  | {state: "loading"}
  | {state: "ready"; data: GraveyardResponse}
  | {state: "error"; message: string};

export default function GraveyardPage() {
  return <Graveyard />;
}

function Graveyard() {
  const [data, setData] = useState<FetchState>({state: "loading"});
  const [sort, setSort] = useState<GraveyardSort>("recent");
  const [season, setSeason] = useState<string>("");
  const [ticker, setTicker] = useState<string>("");
  const [nearMissOnly, setNearMissOnly] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const PER_PAGE = 50;

  // Bugbot PR #103 pass-19: debounce text inputs so typing "DOOM" no longer
  // fires four sequential /graveyard fetches. Toggles + sort + page still
  // fire immediately; only the free-text fields (season/ticker) wait.
  const [debouncedSeason, setDebouncedSeason] = useState<string>("");
  const [debouncedTicker, setDebouncedTicker] = useState<string>("");
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSeason(season);
      setDebouncedTicker(ticker);
    }, 250);
    return () => clearTimeout(handle);
  }, [season, ticker]);

  useEffect(() => {
    let cancelled = false;
    setData({state: "loading"});
    fetchGraveyard({
      sort,
      page,
      perPage: PER_PAGE,
      season: debouncedSeason ? Number(debouncedSeason) : null,
      ticker: debouncedTicker.length > 0 ? debouncedTicker : null,
      nearMiss: nearMissOnly,
    })
      .then((resp) => {
        if (!cancelled) setData({state: "ready", data: resp});
      })
      .catch((err) => {
        if (cancelled) return;
        setData({
          state: "error",
          message: err instanceof Error ? err.message : "failed to load graveyard",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [sort, page, debouncedSeason, debouncedTicker, nearMissOnly]);

  // Closest near-misses across the current page. The dispatch calls for a
  // cross-season hero strip; for genesis volumes (a few seasons) the current
  // page is effectively the full archive, so this works as a hero strip
  // proxy. Once the archive grows past one page, swap to a dedicated
  // /graveyard/closest-near-misses query.
  const closestNearMisses: GraveyardTokenRow[] = useMemo(() => {
    if (data.state !== "ready") return [];
    return [...data.data.tokens]
      .filter((t) => t.isNearMiss && t.nearMissMarginHp !== null)
      .sort(
        (a, b) =>
          (a.nearMissMarginHp ?? Number.MAX_SAFE_INTEGER) -
          (b.nearMissMarginHp ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, 3);
  }, [data]);

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: "32px 24px 64px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <BackToArena />
      <Header />
      <FilterBar
        sort={sort}
        season={season}
        ticker={ticker}
        nearMissOnly={nearMissOnly}
        onSort={(s) => {
          setSort(s);
          setPage(1);
        }}
        onSeason={(s) => {
          setSeason(s);
          setPage(1);
        }}
        onTicker={(t) => {
          setTicker(t);
          setPage(1);
        }}
        onNearMissOnly={(v) => {
          setNearMissOnly(v);
          setPage(1);
        }}
      />
      {closestNearMisses.length > 0 ? (
        <HeroStrip rows={closestNearMisses} />
      ) : null}
      {data.state === "loading" ? (
        <Loading />
      ) : data.state === "error" ? (
        <ErrorBlock message={data.message} />
      ) : data.data.tokens.length === 0 ? (
        <EmptyState />
      ) : (
        <SeasonGroupedList rows={data.data.tokens} />
      )}
      {data.state === "ready" && data.data.total > data.data.perPage ? (
        <Pagination
          page={page}
          perPage={data.data.perPage}
          total={data.data.total}
          onPage={setPage}
        />
      ) : null}
    </main>
  );
}

function Header() {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 4}}>
      <div
        style={{
          fontSize: 12,
          color: C.dim,
          fontFamily: F.mono,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        ▼ Archive
      </div>
      <div
        style={{
          fontSize: 32,
          fontFamily: F.display,
          fontWeight: 800,
          color: C.text,
          letterSpacing: "-0.02em",
        }}
      >
        Graveyard
      </div>
      <div style={{fontSize: 13, color: C.dim, maxWidth: 600}}>
        Every token that got filtered. Spec §36.1.2 — they remain tradable on
        whatever organic liquidity stuck around.
      </div>
    </div>
  );
}

function FilterBar(props: {
  sort: GraveyardSort;
  season: string;
  ticker: string;
  nearMissOnly: boolean;
  onSort: (s: GraveyardSort) => void;
  onSeason: (s: string) => void;
  onTicker: (t: string) => void;
  onNearMissOnly: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        padding: 12,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        alignItems: "center",
      }}
    >
      <input
        type="text"
        value={props.ticker}
        onChange={(e) => props.onTicker(e.target.value)}
        placeholder="Search ticker"
        style={inputStyle()}
        aria-label="Search by ticker substring"
      />
      <input
        type="text"
        value={props.season}
        onChange={(e) => props.onSeason(e.target.value.replace(/[^0-9]/g, ""))}
        placeholder="Season #"
        style={{...inputStyle(), maxWidth: 100}}
        aria-label="Filter by season"
      />
      <select
        value={props.sort}
        onChange={(e) => props.onSort(e.target.value as GraveyardSort)}
        style={inputStyle()}
        aria-label="Sort"
      >
        <option value="recent">Most recent</option>
        <option value="season">By season</option>
        <option value="rank">By final rank</option>
        <option value="nearMissMargin">By near-miss margin</option>
        <option value="peakHp">By peak HP</option>
        <option value="creator">By creator</option>
      </select>
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: C.dim,
          fontFamily: F.mono,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={props.nearMissOnly}
          onChange={(e) => props.onNearMissOnly(e.target.checked)}
        />
        Near-miss only
      </label>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    background: C.bg,
    border: `1px solid ${C.line}`,
    color: C.text,
    fontFamily: F.mono,
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 6,
    outline: "none",
  };
}

function HeroStrip({rows}: {rows: ReadonlyArray<GraveyardTokenRow>}) {
  return (
    <div
      style={{
        padding: 16,
        background: `linear-gradient(135deg, ${C.bg2}, ${C.panel})`,
        border: `1px solid ${C.red}33`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.red,
          fontFamily: F.mono,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 700,
        }}
      >
        ▼ Closest near-misses
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        {rows.map((row) => (
          <Link
            key={row.address}
            href={`/graveyard/${row.address}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 12,
              background: C.bg,
              border: `1px solid ${C.line}`,
              borderRadius: 10,
              textDecoration: "none",
              color: C.text,
            }}
          >
            <div style={{display: "flex", alignItems: "center", gap: 8}}>
              <span style={{fontFamily: F.mono, fontWeight: 700, fontSize: 14}}>
                {row.ticker}
              </span>
              <span style={{fontSize: 11, color: C.dim}}>Week {row.season}</span>
            </div>
            {row.nearMissMarginHp !== null ? (
              <NearMissChip marginHp={row.nearMissMarginHp} variant="filtered" />
            ) : null}
            <span style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>
              just barely filtered
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function SeasonGroupedList({rows}: {rows: ReadonlyArray<GraveyardTokenRow>}) {
  // Group by season for the default view.
  const bySeason = new Map<number, GraveyardTokenRow[]>();
  for (const r of rows) {
    const arr = bySeason.get(r.season) ?? [];
    arr.push(r);
    bySeason.set(r.season, arr);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => b - a);
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 16}}>
      {seasons.map((s) => (
        <SeasonGroup key={s} season={s} rows={bySeason.get(s)!} />
      ))}
    </div>
  );
}

function SeasonGroup({season, rows}: {season: number; rows: ReadonlyArray<GraveyardTokenRow>}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 8}}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          fontFamily: F.mono,
          fontSize: 11,
          color: C.dim,
          letterSpacing: "0.04em",
        }}
      >
        <span style={{color: C.text, fontWeight: 700, fontSize: 14}}>Week {season}</span>
        <span>{rows.length} filtered</span>
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: 6}}>
        {rows.map((r) => (
          <GraveyardRow key={r.address} row={r} />
        ))}
      </div>
    </div>
  );
}

function GraveyardRow({row}: {row: GraveyardTokenRow}) {
  return (
    <Link
      href={`/graveyard/${row.address}`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1.2fr) auto auto auto auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        textDecoration: "none",
        color: C.text,
      }}
    >
      <span style={{fontFamily: F.mono, fontWeight: 600, fontSize: 14}}>
        {row.ticker}
      </span>
      <span style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>
        {row.creatorUsername ?? shortAddr(row.creator)}
      </span>
      <span style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>
        rank #{row.finalRank ?? "—"}
      </span>
      <span style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>
        peak {row.peakHp}
      </span>
      {row.isNearMiss && row.nearMissMarginHp !== null ? (
        <NearMissChip marginHp={row.nearMissMarginHp} variant="filtered" />
      ) : (
        <span style={{fontSize: 11, color: C.faint, fontFamily: F.mono}}>
          final {row.finalHp}
        </span>
      )}
      {row.tradableNow ? (
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: `${C.cyan}1a`,
            border: `1px solid ${C.cyan}55`,
            color: C.cyan,
            fontSize: 10,
            fontFamily: F.mono,
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          TRADABLE
        </span>
      ) : (
        <span />
      )}
    </Link>
  );
}

function Pagination({
  page,
  perPage,
  total,
  onPage,
}: {
  page: number;
  perPage: number;
  total: number;
  onPage: (n: number) => void;
}) {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        gap: 12,
        marginTop: 16,
        fontFamily: F.mono,
        fontSize: 12,
        color: C.dim,
      }}
    >
      <button
        type="button"
        onClick={() => onPage(Math.max(1, page - 1))}
        disabled={page <= 1}
        style={paginationButton(page <= 1)}
      >
        ← prev
      </button>
      <span>
        page {page} / {lastPage} ({total} filtered)
      </span>
      <button
        type="button"
        onClick={() => onPage(Math.min(lastPage, page + 1))}
        disabled={page >= lastPage}
        style={paginationButton(page >= lastPage)}
      >
        next →
      </button>
    </div>
  );
}

function paginationButton(disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${C.line}`,
    color: disabled ? C.faint : C.text,
    fontFamily: F.mono,
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function Loading() {
  return (
    <div
      style={{
        padding: "48px 0",
        color: C.dim,
        fontSize: 13,
        fontFamily: F.mono,
        textAlign: "center",
      }}
    >
      Loading the graveyard…
    </div>
  );
}

function ErrorBlock({message}: {message: string}) {
  return (
    <div style={{color: C.red, fontFamily: F.mono, fontSize: 13}}>
      Error: {message}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        padding: "48px 0",
        color: C.dim,
        fontFamily: F.display,
        fontSize: 16,
        textAlign: "center",
      }}
    >
      The graveyard is empty. Yet.
    </div>
  );
}

function BackToArena() {
  return (
    <Link
      href="/"
      style={{
        fontSize: 12,
        color: C.dim,
        textDecoration: "none",
        letterSpacing: "0.04em",
        fontFamily: F.mono,
      }}
    >
      ← arena
    </Link>
  );
}
