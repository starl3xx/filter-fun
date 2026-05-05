"use client";

/// `/w/[identifier]` — Epic 1.26 (spec §11.4 / §10.3 / §36.1.6).
///
/// Long-tail winner detail page. `:identifier` accepts EITHER a 0x address OR
/// a season-id (`/w/7` resolves to that season's winner via the indexer's
/// `/season/:id` margin payload, then redirects to `/w/<address>`).
/// Three-column composition: winner identity + squeaker callout · big visual
/// reserve growth + fee accrual + holder retention charts · trade CTA + cross-
/// links. NO leaderboard / countdown / HP-pulse — winners aren't a tournament,
/// they're the long tail.

import {useEffect, useState} from "react";
import {useParams, useRouter} from "next/navigation";
import Link from "next/link";

import {C, F} from "@/lib/tokens";
import {
  fetchWinnerMetrics,
  tradeTokenUrl,
  INDEXER_URL,
  type WinnerMetricsResponse,
} from "@/lib/arena/api";
import {deploymentMeta} from "@/lib/addresses";

import {NearMissChip, formatMarginHp} from "@/components/graveyard/NearMissChip";
import {TimeSeriesChart} from "@/components/winner/TimeSeriesChart";
import {shortAddr} from "@/lib/launch/format";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SEASON_ID_RE = /^[0-9]+$/;

type FetchState =
  | {state: "loading"}
  | {state: "ready"; data: WinnerMetricsResponse}
  | {state: "not-found"}
  | {state: "error"; message: string};

export default function WinnerPage() {
  const params = useParams<{identifier: string}>();
  const raw = params?.identifier ?? "";
  if (ADDRESS_RE.test(raw)) {
    return <Winner address={raw as `0x${string}`} />;
  }
  if (SEASON_ID_RE.test(raw)) {
    return <ResolveSeasonId rawId={raw} />;
  }
  return <NotFound />;
}

/// Resolve `/w/<season-id>` → fetch the season's winner address, then redirect
/// to `/w/<address>` so the canonical URL is always address-based.
function ResolveSeasonId({rawId}: {rawId: string}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // We have no /season/:id helper yet, but the indexer endpoint exists.
    // Fetch directly.
    (async () => {
      try {
        // Re-use fetchSeason (which hits /season/latest) only as a fallback
        // when the id matches latest; otherwise issue a raw fetch.
        // Bugbot PR #103: reuse the shared `INDEXER_URL` constant so we get
        // the trailing-slash strip; the prior inline `process.env.…` form
        // could yield `https://host//season/7` if the env var ended with `/`.
        const res = await fetch(`${INDEXER_URL}/season/${rawId}`, {cache: "no-store"});
        // Bugbot PR #103 pass-12: /season/:id now returns 404 for unknown
        // ids (formerly 200 + "not-ready", which conflated "doesn't exist"
        // with "not yet indexed"). Treat 404 as a distinct user-facing
        // message so spectators see "no such season" not a generic error.
        if (res.status === 404) {
          if (!cancelled) setError("That season doesn't exist.");
          return;
        }
        if (!res.ok) throw new Error(`/season/${rawId} → ${res.status}`);
        const body = (await res.json()) as {
          status: string;
          season: {seasonId: number; winner?: `0x${string}` | null} | null;
        };
        if (cancelled) return;
        if (body.status !== "ready" || !body.season) {
          setError("Season not yet indexed.");
          return;
        }
        // Bugbot PR #103 pass-16: /season/:id now surfaces `winner`, so
        // resolve the redirect target inline. Skip the redundant /winners
        // fetch the previous version did to look up the same address.
        if (!body.season.winner) {
          setError("That season hasn't finalized yet.");
          return;
        }
        router.replace(`/w/${body.season.winner}`);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to resolve season.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawId, router]);

  if (error) {
    return (
      <Shell>
        <div style={{color: C.red, fontFamily: F.mono}}>Error: {error}</div>
      </Shell>
    );
  }
  return <Shell>Resolving Week {rawId}…</Shell>;
}

function Winner({address}: {address: `0x${string}`}) {
  const [data, setData] = useState<FetchState>({state: "loading"});

  useEffect(() => {
    let cancelled = false;
    setData({state: "loading"});
    fetchWinnerMetrics(address)
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
          message: err instanceof Error ? err.message : "Failed to load winner.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (data.state === "loading") return <Shell>Loading…</Shell>;
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
      <div className="ff-winner-grid">
        <IdentityCard data={d} />
        <CenterColumn data={d} />
        <SidePanel data={d} trade={trade} />
      </div>
      <style jsx>{`
        :global(.ff-winner-grid) {
          display: grid;
          grid-template-columns: 280px minmax(0, 1fr) 280px;
          gap: 24px;
        }
        @media (max-width: 980px) {
          :global(.ff-winner-grid) {
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
      <Link href="/winners" style={{color: C.dim, textDecoration: "none"}}>
        winners
      </Link>
    </div>
  );
}

function IdentityCard({data}: {data: WinnerMetricsResponse}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        background: C.panel,
        border: `1px solid ${C.yellow}55`,
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          borderRadius: 999,
          background: `${C.yellow}1a`,
          border: `1px solid ${C.yellow}66`,
          color: C.yellow,
          fontSize: 11,
          fontFamily: F.mono,
          fontWeight: 700,
          width: "fit-content",
          letterSpacing: "0.04em",
        }}
      >
        🏆 WINNER · WEEK {data.season}
      </div>
      <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 28, color: C.text}}>
        {data.token.ticker}
      </div>
      <div style={{fontSize: 12, color: C.dim, fontFamily: F.mono}}>{data.token.name}</div>
      <div style={{fontSize: 11, color: C.faint, fontFamily: F.mono, wordBreak: "break-all"}}>
        {data.token.address}
      </div>
      {data.isSqueaker && data.winMarginHp !== null ? (
        <div>
          <NearMissChip marginHp={data.winMarginHp} variant="won" />
          <div style={{fontSize: 11, color: C.dim, marginTop: 6, fontFamily: F.mono}}>
            Squeaker — won by {formatMarginHp(data.winMarginHp)}
          </div>
        </div>
      ) : null}
      {data.secondPlace ? (
        <Link
          href={`/graveyard/${data.secondPlace.address}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: 8,
            background: C.bg,
            border: `1px solid ${C.line}`,
            borderRadius: 8,
            textDecoration: "none",
            color: C.text,
            fontFamily: F.mono,
            fontSize: 12,
          }}
        >
          <span style={{fontSize: 10, color: C.dim, letterSpacing: "0.06em", textTransform: "uppercase"}}>
            Runner-up →
          </span>
          <span>
            {data.secondPlace.ticker} · {data.secondPlace.finalHp} HP
          </span>
        </Link>
      ) : null}
      {data.settledAt !== null ? (
        <div style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>
          Settled {formatTimestamp(data.settledAt)}
        </div>
      ) : null}
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

function CenterColumn({data}: {data: WinnerMetricsResponse}) {
  // Reserve growth: visual centerpiece. The latest sample becomes the
  // headline number.
  const latestReserve = data.reserveGrowth[data.reserveGrowth.length - 1];
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 16}}>
      <BigVisual
        title="Filter Fund Liquidity Reserve"
        value={latestReserve ? `${latestReserve.reserveWeth} WETH` : "—"}
        sub="Spec §11.4 — perpetual reserve, fed by post-settlement fees."
      />
      <Panel title="Reserve growth">
        <TimeSeriesChart
          primary={data.reserveGrowth.map((p) => ({
            timestamp: p.timestamp,
            value: Number(p.reserveWeth),
          }))}
          unitLabel=""
          primaryColor={C.cyan}
        />
      </Panel>
      <Panel title="Perpetual creator fee accrual">
        <TimeSeriesChart
          primary={data.feeAccrual.map((p) => ({
            timestamp: p.timestamp,
            value: Number(p.creatorEarnedWeth),
          }))}
          secondary={data.feeAccrual.map((p) => ({
            timestamp: p.timestamp,
            value: Number(p.polTopUpWeth),
          }))}
          primaryColor={C.pink}
          secondaryColor={C.cyan}
          unitLabel=""
        />
        <Legend
          items={[
            {color: C.pink, label: "Creator (20bps, spec §10.3)"},
            {color: C.cyan, label: "Reserve top-up (95bps post-settlement, spec §9.4)"},
          ]}
        />
      </Panel>
      <Panel title="Holder retention">
        <TimeSeriesChart
          primary={data.holderRetention.map((p) => ({
            timestamp: p.timestamp,
            value: p.activeHolders,
          }))}
          secondary={data.holderRetention.map((p) => ({
            timestamp: p.timestamp,
            value: p.fromOriginal,
          }))}
          primaryColor={C.green}
          secondaryColor={C.yellow}
          unitLabel=""
        />
        <Legend
          items={[
            {color: C.green, label: "Active holders"},
            {color: C.yellow, label: "From original (held since settlement)"},
          ]}
        />
      </Panel>
      <Panel title="Where the money came from">
        <p style={{margin: 0, color: C.dim, fontSize: 12, fontFamily: F.mono, marginBottom: 8}}>
          Filter Fund (spec §11) at settlement: 2.5% creator bounty skimmed
          off-the-top, then the remaining 97.5% split 45/25/10/10/10.
        </p>
        <ul style={{margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6}}>
          <Allocation pct="2.5%" label="Creator bounty" sub="off-the-top to this token's creator at h168" color={C.pink} />
        </ul>
        <p style={{margin: "12px 0 6px", color: C.dim, fontSize: 11, fontFamily: F.mono, textTransform: "uppercase", letterSpacing: 0.5}}>
          Of the remaining 97.5%
        </p>
        <ul style={{margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6}}>
          <Allocation pct="45%" label="Rollover" sub="airdropped to filtered-token holders" color={C.purple} />
          <Allocation pct="25%" label="Hold bonus" sub="airdropped to this token's 14-day holders" color={C.yellow} />
          <Allocation pct="10%" label="Reserve" sub="this chart, perpetual" color={C.cyan} />
          <Allocation pct="10%" label="Mechanics" sub="oracle + scheduler ops" color={C.dim} />
          <Allocation pct="10%" label="Treasury" sub="48h timelocked governance" color={C.dim} />
        </ul>
      </Panel>
    </div>
  );
}

function BigVisual({title, value, sub}: {title: string; value: string; sub: string}) {
  return (
    <div
      style={{
        padding: 24,
        background: `linear-gradient(135deg, ${C.bg2}, ${C.panel})`,
        border: `1px solid ${C.cyan}33`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.cyan,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontFamily: F.mono,
          fontWeight: 700,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 48,
          fontFamily: F.display,
          fontWeight: 800,
          color: C.cyan,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      <div style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>{sub}</div>
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

function Legend({items}: {items: Array<{color: string; label: string}>}) {
  return (
    <div style={{display: "flex", flexWrap: "wrap", gap: 16, fontSize: 11, color: C.dim, fontFamily: F.mono}}>
      {items.map((i) => (
        <span key={i.label} style={{display: "inline-flex", alignItems: "center", gap: 6}}>
          <span style={{width: 10, height: 2, background: i.color, display: "inline-block"}} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Allocation({
  pct,
  label,
  sub,
  color,
}: {
  pct: string;
  label: string;
  sub: string;
  color: string;
}) {
  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "60px minmax(0, 1fr)",
        gap: 12,
        alignItems: "baseline",
        padding: "6px 0",
        borderBottom: `1px solid ${C.lineSoft}`,
      }}
    >
      <span style={{color, fontFamily: F.display, fontWeight: 700, fontSize: 16}}>{pct}</span>
      <span>
        <span style={{color: C.text, fontFamily: F.mono, fontSize: 13, fontWeight: 600}}>{label}</span>
        <span style={{color: C.dim, fontSize: 11, fontFamily: F.mono, display: "block"}}>{sub}</span>
      </span>
    </li>
  );
}

function SidePanel({
  data,
  trade,
}: {
  data: WinnerMetricsResponse;
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
          Trade now
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
          The canonical V4 pool stays active forever.
        </div>
      </div>
      <SideLink
        title="Same season"
        href={`/graveyard?season=${data.season}`}
        sub={`See who else launched Week ${data.season}`}
      />
      <SideLink title="All winners" href="/winners" sub={`Browse the long tail`} />
      <SideLink
        title="By this creator"
        href={`/p/${data.token.creator}`}
        sub={data.token.creatorUsername ?? shortAddr(data.token.creator)}
      />
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
        🏆
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
        No winner here
      </div>
      <div style={{fontSize: 13, color: C.dim, marginBottom: 24}}>
        Either this isn&apos;t a winner address, the season hasn&apos;t finalized,
        or the indexer hasn&apos;t caught up yet.
      </div>
      <Link
        href="/winners"
        style={{color: C.pink, textDecoration: "none", fontSize: 13, fontFamily: F.display, fontWeight: 700}}
      >
        ← Back to winners
      </Link>
    </main>
  );
}

function formatTimestamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
