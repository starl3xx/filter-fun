"use client";

/// `/winners` — Epic 1.26 winners index. Less load-bearing than the graveyard
/// since the winner count is small (one per week).

import {useEffect, useState} from "react";
import Link from "next/link";

import {C, F} from "@/lib/tokens";
import {fetchWinners, type WinnerRow, type WinnersResponse} from "@/lib/arena/api";

import {NearMissChip, formatMarginHp} from "@/components/graveyard/NearMissChip";

/// Mirror of indexer's NEAR_MISS_THRESHOLD_HP (spec §36.3.3, 5pp on the
/// `[0, 10000]` int10k composite scale).
const SQUEAKER_THRESHOLD_HP = 500;

type FetchState =
  | {state: "loading"}
  | {state: "ready"; data: WinnersResponse}
  | {state: "error"; message: string};

export default function WinnersPage() {
  const [data, setData] = useState<FetchState>({state: "loading"});
  useEffect(() => {
    let cancelled = false;
    fetchWinners()
      .then((r) => {
        if (!cancelled) setData({state: "ready", data: r});
      })
      .catch((err) => {
        if (cancelled) return;
        setData({
          state: "error",
          message: err instanceof Error ? err.message : "Failed to load",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      <Link
        href="/"
        style={{fontSize: 12, color: C.dim, textDecoration: "none", fontFamily: F.mono}}
      >
        ← arena
      </Link>
      <Header />
      {data.state === "loading" ? (
        <Loading />
      ) : data.state === "error" ? (
        <ErrorBlock message={data.message} />
      ) : data.data.winners.length === 0 ? (
        <EmptyState />
      ) : (
        <Body winners={data.data.winners} />
      )}
    </main>
  );
}

function Header() {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 4}}>
      <div
        style={{
          fontSize: 12,
          color: C.yellow,
          fontFamily: F.mono,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        🏆 Champions
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
        Winners
      </div>
      <div style={{fontSize: 13, color: C.dim, maxWidth: 600}}>
        Every weekly champion. The Filter Fund Liquidity Reserve keeps growing
        for each one — perpetual fees route in forever (spec §11.4 / §10.3).
      </div>
    </div>
  );
}

function Body({winners}: {winners: ReadonlyArray<WinnerRow>}) {
  const squeakers = winners.filter((w) => w.isSqueaker && w.winMarginHp !== null);
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 20}}>
      {squeakers.length > 0 ? <SqueakerStrip rows={squeakers} /> : null}
      <div style={{display: "flex", flexDirection: "column", gap: 6}}>
        {winners.map((w) => (
          <WinnerRowCard key={w.address} row={w} />
        ))}
      </div>
    </div>
  );
}

function SqueakerStrip({rows}: {rows: ReadonlyArray<WinnerRow>}) {
  return (
    <div
      style={{
        padding: 16,
        background: `linear-gradient(135deg, ${C.bg2}, ${C.panel})`,
        border: `1px solid ${C.yellow}33`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.yellow,
          fontFamily: F.mono,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 700,
        }}
      >
        Squeakers · won by ≤{formatMarginHp(SQUEAKER_THRESHOLD_HP)}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        {rows.slice(0, 4).map((r) => (
          <Link
            key={r.address}
            href={`/w/${r.address}`}
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
                {r.ticker}
              </span>
              <span style={{fontSize: 11, color: C.dim}}>Week {r.season}</span>
            </div>
            {r.winMarginHp !== null ? (
              <NearMissChip marginHp={r.winMarginHp} variant="won" />
            ) : null}
          </Link>
        ))}
      </div>
    </div>
  );
}

function WinnerRowCard({row}: {row: WinnerRow}) {
  return (
    <Link
      href={`/w/${row.address}`}
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1.5fr) minmax(0, 1fr) auto auto",
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
      <span style={{fontFamily: F.mono, color: C.yellow, fontWeight: 700, fontSize: 12}}>
        WK {row.season}
      </span>
      <span style={{fontFamily: F.mono, fontWeight: 600, fontSize: 14}}>{row.ticker}</span>
      <span style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>
        {row.creatorUsername ?? shortAddr(row.creator)}
      </span>
      {row.isSqueaker && row.winMarginHp !== null ? (
        <NearMissChip marginHp={row.winMarginHp} variant="won" />
      ) : (
        <span style={{fontSize: 11, color: C.faint, fontFamily: F.mono}}>
          {row.winMarginHp !== null ? `+${formatMarginHp(row.winMarginHp)}` : "—"}
        </span>
      )}
      <span style={{fontSize: 11, color: C.cyan, fontFamily: F.mono}}>
        {row.currentReserveWeth} WETH reserve
      </span>
    </Link>
  );
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function Loading() {
  return (
    <div
      style={{
        padding: "48px 0",
        color: C.dim,
        fontFamily: F.mono,
        fontSize: 13,
        textAlign: "center",
      }}
    >
      Loading winners…
    </div>
  );
}

function ErrorBlock({message}: {message: string}) {
  return (
    <div style={{color: C.red, fontFamily: F.mono, fontSize: 13}}>Error: {message}</div>
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
      No winners crowned yet. Wait for h168.
    </div>
  );
}
