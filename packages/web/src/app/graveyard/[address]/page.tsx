"use client";

/// `/graveyard/[address]` — per-token historical page (Epic 1.25).
///
/// Three-column layout (collapses on mobile): identity card · trajectory +
/// recap · cross-links + tradable CTA. Read-only; spec §36.1.2 keeps
/// filtered tokens tradable via the canonical V4 pool.

import {useEffect, useState} from "react";
import {useParams} from "next/navigation";
import Link from "next/link";

import {C, F} from "@/lib/tokens";
import {
  fetchGraveyardDetail,
  tradeTokenUrl,
  type GraveyardDetailResponse,
} from "@/lib/arena/api";
import {deploymentMeta} from "@/lib/addresses";

import {NearMissChip, formatMarginHp} from "@/components/graveyard/NearMissChip";
import {HpTrajectoryChart} from "@/components/graveyard/HpTrajectoryChart";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type FetchState =
  | {state: "loading"}
  | {state: "ready"; data: GraveyardDetailResponse}
  | {state: "not-found"}
  | {state: "error"; message: string};

export default function GraveyardDetailPage() {
  const params = useParams<{address: string}>();
  const raw = params?.address ?? "";
  if (!ADDRESS_RE.test(raw)) {
    return <NotFound />;
  }
  return <Detail address={raw as `0x${string}`} />;
}

function Detail({address}: {address: `0x${string}`}) {
  const [data, setData] = useState<FetchState>({state: "loading"});

  useEffect(() => {
    let cancelled = false;
    setData({state: "loading"});
    fetchGraveyardDetail(address)
      .then((r) => {
        if (!cancelled) setData({state: "ready", data: r});
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof Error && err.message.includes("→ 404")) {
          setData({state: "not-found"});
          return;
        }
        setData({
          state: "error",
          message: err instanceof Error ? err.message : "failed to load",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (data.state === "loading") {
    return <Shell>Loading…</Shell>;
  }
  if (data.state === "not-found") return <NotFound />;
  if (data.state === "error") {
    return <Shell><div style={{color: C.red}}>Error: {data.message}</div></Shell>;
  }

  const d = data.data;
  const chain = deploymentMeta.network === "base" ? "base" : "base-sepolia";
  const trade = tradeTokenUrl(d.token.address, chain);

  return (
    <Shell>
      <BackLinks />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 24,
        }}
      >
        <div className="ff-graveyard-grid">
          <IdentityCard data={d} />
          <CenterColumn data={d} />
          <SidePanel data={d} trade={trade} />
        </div>
      </div>
      <style jsx>{`
        :global(.ff-graveyard-grid) {
          display: grid;
          grid-template-columns: 280px minmax(0, 1fr) 280px;
          gap: 24px;
        }
        @media (max-width: 980px) {
          :global(.ff-graveyard-grid) {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
    </Shell>
  );
}

function Shell({children}: {children: React.ReactNode}) {
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
      {children}
    </main>
  );
}

function BackLinks() {
  return (
    <div style={{display: "flex", gap: 12, fontSize: 12, fontFamily: F.mono, color: C.dim}}>
      <Link href="/" style={{color: C.dim, textDecoration: "none"}}>
        ← arena
      </Link>
      <Link href="/graveyard" style={{color: C.dim, textDecoration: "none"}}>
        graveyard
      </Link>
    </div>
  );
}

function IdentityCard({data}: {data: GraveyardDetailResponse}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.dim,
          fontFamily: F.mono,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        ▼ Filtered
      </div>
      <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 28, color: C.text}}>
        {data.token.ticker}
      </div>
      <div style={{fontSize: 12, color: C.dim, fontFamily: F.mono}}>
        {data.token.name}
      </div>
      <div style={{fontSize: 11, color: C.faint, fontFamily: F.mono, wordBreak: "break-all"}}>
        {data.token.address}
      </div>
      <Divider />
      <KV label="Season" value={`Week ${data.season.id}`} />
      <KV label="Final rank" value={data.lifecycle.finalRank ? `#${data.lifecycle.finalRank}` : "—"} />
      <KV
        label="Filter round"
        value={data.lifecycle.filterRound ?? "—"}
      />
      <KV
        label="Launched"
        value={formatTimestamp(data.lifecycle.launchedAt)}
      />
      {data.lifecycle.filteredAt !== null ? (
        <KV
          label="Filtered"
          value={formatTimestamp(data.lifecycle.filteredAt)}
        />
      ) : null}
      <Divider />
      <Link
        href={`/p/${data.token.creator}`}
        style={{
          fontFamily: F.mono,
          fontSize: 12,
          color: C.cyan,
          textDecoration: "none",
        }}
      >
        Creator: {data.token.creatorUsername ?? shortAddr(data.token.creator)}
      </Link>
    </div>
  );
}

function CenterColumn({data}: {data: GraveyardDetailResponse}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 16}}>
      <LifecycleBanner data={data} />
      <Panel title="HP trajectory">
        <HpTrajectoryChart
          points={data.hpTrajectory}
          cutLineHp={cutLineFromMargin(data.lifecycle.finalHp, data.lifecycle.nearMissMarginHp)}
          filteredAtSec={data.lifecycle.filteredAt}
          peakHp={data.lifecycle.peakHp}
          peakAtSec={data.lifecycle.peakHpAt}
        />
      </Panel>
      <Panel title="LP events">
        {data.lpEvents.length === 0 ? (
          <Empty>No LP events indexed.</Empty>
        ) : (
          <ul style={{listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6}}>
            {data.lpEvents.map((e, i) => (
              <li
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 12,
                  fontFamily: F.mono,
                  fontSize: 12,
                  color: C.dim,
                }}
              >
                <span style={{color: e.kind === "BURN" ? C.red : C.green, fontWeight: 600}}>
                  {e.kind}
                </span>
                <span>{formatTimestamp(e.timestamp)}</span>
                <span style={{color: C.text}}>{e.amountWeth} WETH</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Holders over time">
        {data.holderTrajectory.length === 0 ? (
          <Empty>No holder snapshots indexed.</Empty>
        ) : (
          <ul style={{listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4}}>
            {data.holderTrajectory.map((p, i) => (
              <li
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  fontFamily: F.mono,
                  fontSize: 12,
                  color: C.dim,
                }}
              >
                <span>{formatTimestamp(p.timestamp)}</span>
                <span style={{color: C.text}}>{p.holders} holders</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <RecapCard data={data} />
    </div>
  );
}

function LifecycleBanner({data}: {data: GraveyardDetailResponse}) {
  const {peakHp, finalHp, filterRound, nearMissMarginHp, isNearMiss} = data.lifecycle;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 12,
        padding: 16,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
      }}
    >
      <Stat label="Peak HP" value={peakHp.toString()} color={C.yellow} />
      <Stat label="Final HP" value={finalHp.toString()} color={C.cyan} />
      <Stat
        label={filterRound === "FINALIZE" ? "Filtered at h168" : "Filtered at h96"}
        value={isNearMiss && nearMissMarginHp !== null ? formatMarginHp(nearMissMarginHp) : "—"}
        color={C.red}
      />
      {isNearMiss && nearMissMarginHp !== null ? (
        <div style={{gridColumn: "1 / -1"}}>
          <NearMissChip marginHp={nearMissMarginHp} variant="filtered" />
        </div>
      ) : null}
    </div>
  );
}

function Stat({label, value, color}: {label: string; value: string; color: string}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 4}}>
      <div
        style={{
          fontSize: 10,
          color: C.dim,
          letterSpacing: "0.06em",
          fontFamily: F.mono,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{fontSize: 24, fontFamily: F.display, fontWeight: 800, color}}>
        {value}
      </div>
    </div>
  );
}

function Panel({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div
      style={{
        padding: 16,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.dim,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontFamily: F.mono,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function RecapCard({data}: {data: GraveyardDetailResponse}) {
  const {finalHp, finalRank, peakHp, peakHpAt, filteredAt, nearMissMarginHp, filterRound} = data.lifecycle;
  // Generate the natural-language recap. Spec-compliant phrasing — no
  // manufactured drama (don't-change posture from §36.3.3).
  const sentences: string[] = [];
  if (finalRank !== null) {
    sentences.push(
      `${data.token.ticker} finished Week ${data.season.id} in ${ordinal(finalRank)} place with ${finalHp} HP.`,
    );
  } else {
    sentences.push(
      `${data.token.ticker} was filtered in Week ${data.season.id} with ${finalHp} HP.`,
    );
  }
  if (nearMissMarginHp !== null && nearMissMarginHp > 0) {
    sentences.push(
      `That was ${formatMarginHp(nearMissMarginHp)} behind the cut line.`,
    );
  } else if (nearMissMarginHp === 0) {
    sentences.push("It finished exactly at the cut line.");
  }
  if (peakHpAt !== null) {
    sentences.push(`Peak HP was ${peakHp} at ${formatTimestamp(peakHpAt)}.`);
  }
  if (filterRound === "FINALIZE") {
    sentences.push("Filtered in the finals (h168).");
  } else if (filteredAt !== null) {
    sentences.push("Filtered at the h96 cut.");
  }
  sentences.push(
    "The token remains tradable on its canonical V4 pool with whatever organic liquidity stuck around (spec §36.1.2).",
  );
  return (
    <Panel title="How it ended">
      <p style={{margin: 0, color: C.text, fontSize: 13, lineHeight: 1.55}}>
        {sentences.join(" ")}
      </p>
    </Panel>
  );
}

function SidePanel({
  data,
  trade,
}: {
  data: GraveyardDetailResponse;
  trade: {url: string; label: string};
}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 12}}>
      <div
        style={{
          padding: 12,
          background: C.panel,
          border: `1px solid ${C.cyan}33`,
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: C.cyan,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontFamily: F.mono,
            fontWeight: 700,
          }}
        >
          Tradable now
        </div>
        <a
          href={trade.url}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-block",
            padding: "10px 14px",
            background: C.cyan,
            color: "#001214",
            textDecoration: "none",
            fontFamily: F.display,
            fontWeight: 700,
            fontSize: 13,
            borderRadius: 8,
            textAlign: "center",
            letterSpacing: "0.02em",
          }}
        >
          {trade.label} →
        </a>
        <div style={{fontSize: 10, color: C.dim, fontFamily: F.mono}}>
          Spec §36.1.2 — filtered tokens stay tradable on whatever organic LP
          remains.
        </div>
      </div>
      <SideLink
        title="Same season"
        href={`/graveyard?season=${data.season.id}`}
        sub="See who else launched"
      />
      <SideLink
        title="By this creator"
        href={`/p/${data.token.creator}`}
        sub={data.token.creatorUsername ?? shortAddr(data.token.creator)}
      />
      {data.season.winner ? (
        <SideLink
          title="That week's winner"
          href={`/w/${data.season.winner}`}
          sub="🏆 see the long tail"
        />
      ) : null}
    </div>
  );
}

function SideLink({title, href, sub}: {title: string; href: string; sub: string}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 12,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        textDecoration: "none",
        color: C.text,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: C.dim,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontFamily: F.mono,
          fontWeight: 600,
        }}
      >
        {title} →
      </span>
      <span style={{fontSize: 13, color: C.text, fontFamily: F.mono}}>{sub}</span>
    </Link>
  );
}

function KV({label, value}: {label: string; value: string}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", fontSize: 12}}>
      <span style={{color: C.dim, fontFamily: F.mono}}>{label}</span>
      <span style={{color: C.text, fontFamily: F.mono}}>{value}</span>
    </div>
  );
}

function Divider() {
  return <div style={{height: 1, background: C.lineSoft}} />;
}

function Empty({children}: {children: React.ReactNode}) {
  return (
    <div style={{color: C.dim, fontFamily: F.mono, fontSize: 12}}>{children}</div>
  );
}

function NotFound() {
  return (
    <main
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "96px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 800,
          fontFamily: F.display,
          color: C.text,
          marginBottom: 16,
        }}
      >
        ▼
      </div>
      <div
        style={{
          fontSize: 18,
          color: C.text,
          marginBottom: 8,
          fontFamily: F.display,
          fontWeight: 700,
        }}
      >
        Not in the graveyard
      </div>
      <div style={{fontSize: 13, color: C.dim, marginBottom: 24}}>
        Either this isn&apos;t a real address, the token wasn&apos;t filtered, or the
        indexer hasn&apos;t caught up yet.
      </div>
      <Link
        href="/graveyard"
        style={{color: C.pink, textDecoration: "none", fontSize: 13, fontFamily: F.display, fontWeight: 700}}
      >
        ← Back to the graveyard
      </Link>
    </main>
  );
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function formatTimestamp(unixSec: number): string {
  // ISO without seconds, in local time. Compact: "May 5 09:35".
  const d = new Date(unixSec * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function cutLineFromMargin(finalHp: number, marginHp: number | null): number | null {
  if (marginHp === null) return null;
  return finalHp + marginHp;
}
