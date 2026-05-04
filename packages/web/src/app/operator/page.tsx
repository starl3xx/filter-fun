"use client";

/// `/operator` — Operator Admin Console (Epic 1.21 / spec §47).
///
/// Single scrollable page; 8 dashboard cards (spec §47.3) + an actions panel
/// (spec §47.4). Server-side gating happens at the indexer (`OPERATOR_WALLETS`
/// env + signed-message check); this client also redirects non-operator wallets
/// to `/` so the surface isn't discoverable.
///
/// The page deliberately does NOT auto-prompt the wallet to sign on mount.
/// Reads are explicit: a "Sign in to load operator data" button kicks off the
/// initial fetch sequence. That keeps the wallet-prompt cadence predictable
/// (one sign per session, then re-signs on refresh) and avoids the "operator
/// opens the page, gets 5 wallet prompts in a row" UX trap.

import {useCallback, useEffect, useState} from "react";
import {useConnect} from "wagmi";

import {AlertsBanner} from "@/components/operator/AlertsBanner";
import {ActionsPanel} from "@/components/operator/Actions";
import {
  ActionAuditCard,
  BagLockSurfaceCard,
  FilterClubCard,
  FinancialOverviewCard,
  InfraHealthCard,
  ReservationStateCard,
  ScoringConfigCard,
  SeasonStateCard,
  SettlementProvenanceCard,
} from "@/components/operator/Dashboards";
import {TopBar} from "@/components/broadcast/TopBar";
import {useSeason} from "@/hooks/arena/useSeason";
import {useTokens} from "@/hooks/arena/useTokens";
import {useOperatorAuth} from "@/hooks/operator/useOperatorAuth";
import {INDEXER_URL} from "@/lib/arena/api";
import type {SeasonResponse, TokenResponse} from "@/lib/arena/api";
import {
  fetchAlerts,
  fetchFinancialOverview,
  fetchOperatorActions,
  fetchSettlementHistory,
  type AlertEntry,
  type FinancialOverview,
  type OperatorActionRow,
  type SettlementHistoryEntry,
} from "@/lib/operator/api";
import {OPERATOR_ALLOWLIST} from "@/lib/operator/config";
import {C, F} from "@/lib/tokens";

const ALERTS_REFRESH_MS = 30_000;

export default function OperatorConsolePage() {
  const auth = useOperatorAuth();
  const {connect, connectors} = useConnect();

  // Client-side redirect for non-operator wallets per spec §47.2. Run from a
  // useEffect because Next.js' App Router needs the redirect to fire after
  // hydration — `redirect()` from `next/navigation` is server-only.
  useEffect(() => {
    if (auth.state === "READ_ONLY" && typeof window !== "undefined") {
      window.location.replace("/");
    }
  }, [auth.state]);

  if (auth.state === "DISCONNECTED") {
    return (
      <Shell>
        <DisconnectedBanner
          onConnect={() => {
            const injected = connectors.find((c) => c.type === "injected");
            if (injected) connect({connector: injected});
          }}
        />
      </Shell>
    );
  }
  if (auth.state === "READ_ONLY") {
    return (
      <Shell>
        <RedirectingBanner />
      </Shell>
    );
  }
  if (auth.state === "LOADING" || !auth.signer) {
    return (
      <Shell>
        <p style={{color: C.faint, fontFamily: F.mono, fontSize: 12}}>Loading wallet…</p>
      </Shell>
    );
  }

  return <OperatorConsole signer={auth.signer} address={auth.address!} />;
}

function OperatorConsole({
  signer,
  address,
}: {
  signer: NonNullable<ReturnType<typeof useOperatorAuth>["signer"]>;
  address: `0x${string}`;
}) {
  const {data: season} = useSeason();
  const {data: tokens} = useTokens();
  const [alerts, setAlerts] = useState<AlertEntry[] | null>(null);
  const [financial, setFinancial] = useState<FinancialOverview | null>(null);
  const [history, setHistory] = useState<SettlementHistoryEntry[] | null>(null);
  const [actions, setActions] = useState<OperatorActionRow[] | null>(null);
  const [scoringWeights, setScoringWeights] = useState<{
    version: string;
    weights: Record<string, number>;
    flags: Record<string, boolean>;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      // Fetch the public scoring/weights endpoint without operator auth (it's
      // a public transparency surface — Epic 1.17a). Saves a wallet prompt for
      // a card that doesn't need one.
      const sw = await fetch(`${INDEXER_URL}/scoring/weights`).then((r) => r.json());
      setScoringWeights({
        version: sw.version,
        weights: sw.weights,
        flags: sw.flags,
      });
      const [fin, hist, acts, alertsResp] = await Promise.all([
        fetchFinancialOverview({signer}),
        fetchSettlementHistory({signer, limit: 10}),
        fetchOperatorActions({signer, limit: 50}),
        fetchAlerts({signer}),
      ]);
      setFinancial(fin);
      setHistory(hist.history);
      setActions(acts.actions);
      setAlerts(alertsResp.alerts);
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [signer]);

  // Periodic refresh of alerts only — the dashboard cards are reload-triggered
  // by the operator (one wallet sign per refresh keeps the prompt cadence
  // predictable). Alerts run on a 30s tick because they're the time-sensitive
  // signal; everything else is snapshot data.
  //
  // Polling vs SSE (bugbot PR #95 round 5, Low): the indexer ships an
  // `/operator/alerts/stream` SSE endpoint, but browser `EventSource` can't
  // send the custom auth headers (Authorization / X-Operator-*) the operator
  // routes require. We deliberately poll here. The SSE endpoint is reserved
  // for non-browser clients (ops CLIs, scripts) where header passthrough is
  // trivial — see operator.ts:/operator/alerts/stream for the full rationale.
  useEffect(() => {
    if (!loaded) return;
    const id = window.setInterval(() => {
      fetchAlerts({signer})
        .then((r) => setAlerts(r.alerts))
        .catch(() => {/* swallow — error banner will surface on next manual refresh */});
    }, ALERTS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loaded, signer]);

  // Compute filterFundWei from financial.filterFundBySeason for the current season.
  const filterFundWei = (() => {
    if (!financial || !season) return null;
    const row = financial.filterFundBySeason.find((s) => s.seasonId === String(season.seasonId));
    if (!row) return null;
    try {
      return BigInt(row.totalPotWei);
    } catch {
      return null;
    }
  })();

  return (
    <Shell address={address}>
      {!loaded ? (
        <div style={{padding: 16, maxWidth: 600}}>
          <p style={{color: C.dim, fontFamily: F.display, lineHeight: 1.6, fontSize: 14}}>
            Connected as <code style={{fontFamily: F.mono, color: C.text}}>{address}</code>.
            The operator console reads from operator-gated endpoints — each fetch is signed
            by your wallet (SIWE-style; the 5-min staleness window keeps the signing cadence
            tight). Click below to sign once and pull the dashboards.
          </p>
          <button
            type="button"
            onClick={loadAll}
            style={{
              background: `${C.pink}22`,
              border: `1px solid ${C.pink}66`,
              color: C.pink,
              padding: "10px 20px",
              borderRadius: 8,
              fontFamily: F.display,
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              marginTop: 8,
            }}
          >
            Sign + load operator data
          </button>
          {err && (
            <p style={{color: C.red, fontFamily: F.mono, fontSize: 12, marginTop: 12}}>
              {err}
            </p>
          )}
        </div>
      ) : (
        <>
          <AlertsBanner alerts={alerts ?? []} />
          <div style={{display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)", gap: 16}}>
            <div style={{minWidth: 0}}>
              <SeasonStateCard
                season={season as SeasonResponse | null}
                tokens={tokens as TokenResponse[] | null}
                filterFundWei={filterFundWei}
              />
              <FinancialOverviewCard data={financial} />
              <SettlementProvenanceCard history={history} />
              <ScoringConfigCard
                version={scoringWeights?.version ?? null}
                weights={scoringWeights?.weights ?? null}
                flags={scoringWeights?.flags ?? null}
              />
              <BagLockSurfaceCard tokens={tokens as TokenResponse[] | null} />
              <ReservationStateCard />
              <FilterClubCard />
              <ActionAuditCard rows={actions} />
              <InfraHealthCard
                alertsCount={alerts?.length ?? 0}
                indexerOk={!err}
              />
            </div>
            <aside style={{minWidth: 0}}>
              <ActionsPanel />
            </aside>
          </div>
          <div style={{marginTop: 16}}>
            <button
              type="button"
              onClick={loadAll}
              style={{
                background: "transparent",
                border: `1px solid ${C.line}`,
                color: C.dim,
                padding: "6px 14px",
                borderRadius: 6,
                fontFamily: F.mono,
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Re-sign + refresh dashboards
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({children, address}: {children: React.ReactNode; address?: string}) {
  return (
    <div style={{minHeight: "100vh", background: C.bg}}>
      <TopBar />
      <main style={{padding: "16px 24px", maxWidth: 1400, margin: "0 auto"}}>
        <header style={{marginBottom: 16, display: "flex", alignItems: "baseline", gap: 12}}>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 800,
              fontFamily: F.display,
              letterSpacing: "-0.02em",
              color: C.text,
            }}
          >
            Operator console
          </h1>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 99,
              background: `linear-gradient(135deg, ${C.red}33, ${C.pink}33)`,
              color: C.red,
              fontSize: 10,
              fontWeight: 800,
              fontFamily: F.mono,
              letterSpacing: "0.12em",
              border: `1px solid ${C.red}55`,
              textTransform: "uppercase",
            }}
          >
            ▼ OPERATOR
          </span>
          {address && (
            <span style={{color: C.faint, fontFamily: F.mono, fontSize: 11}}>
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
          )}
        </header>
        {children}
      </main>
    </div>
  );
}

function DisconnectedBanner({onConnect}: {onConnect: () => void}) {
  return (
    <div style={{padding: 16, maxWidth: 600}}>
      <p style={{color: C.dim, fontFamily: F.display, lineHeight: 1.6, fontSize: 14}}>
        Connect an operator wallet to access the console. Your wallet must be in the
        protocol's <code style={{fontFamily: F.mono, color: C.text}}>OPERATOR_WALLETS</code>{" "}
        allow-list (today: {OPERATOR_ALLOWLIST.length} addresses).
      </p>
      <button
        type="button"
        onClick={onConnect}
        style={{
          background: `${C.cyan}22`,
          border: `1px solid ${C.cyan}66`,
          color: C.cyan,
          padding: "10px 20px",
          borderRadius: 8,
          fontFamily: F.display,
          fontSize: 14,
          fontWeight: 700,
          cursor: "pointer",
          marginTop: 8,
        }}
      >
        Connect wallet
      </button>
    </div>
  );
}

function RedirectingBanner() {
  return (
    <div style={{padding: 16, maxWidth: 600}}>
      <p style={{color: C.dim, fontFamily: F.display, fontSize: 14}}>
        Connected wallet is not authorised for the operator console. Redirecting…
      </p>
    </div>
  );
}
