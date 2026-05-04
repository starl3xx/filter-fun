"use client";

import {formatEther} from "viem";

import {OperatorCard} from "./Card";
import type {SeasonResponse} from "@/lib/arena/api";
import type {TokenResponse} from "@/lib/arena/api";
import type {FinancialOverview, OperatorActionRow, SettlementHistoryEntry} from "@/lib/operator/api";
import {C, F} from "@/lib/tokens";

/// Spec §47.3.1 — current season state. Mirrors public Arena view with operator
/// quick-action affordances (force HP recompute is in the Actions panel; this card
/// just renders the live data).
export function SeasonStateCard({
  season,
  tokens,
  filterFundWei,
}: {
  season: SeasonResponse | null;
  tokens: TokenResponse[] | null;
  filterFundWei: bigint | null;
}) {
  return (
    <OperatorCard label="Current season" sublabel="live">
      <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12}}>
        <KV k="Season" v={season ? `#${season.seasonId}` : "—"} />
        <KV k="Phase" v={season?.phase ?? "—"} />
        <KV k="Reservations" v={tokens ? String(tokens.length) : "—"} />
        <KV k="Active tokens" v={tokens ? String(tokens.filter((t) => t.status !== "FILTERED").length) : "—"} />
        <KV k="Filter Fund" v={filterFundWei !== null ? `${formatEther(filterFundWei)} WETH` : "—"} />
      </div>
      {tokens && tokens.length > 0 && (
        <div style={{marginTop: 12}}>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 11,
              color: C.faint,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Leaderboard ({tokens.length})
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: 4}}>
            {tokens.map((t, i) => (
              <div
                key={t.token}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr 80px 80px 100px",
                  gap: 8,
                  fontFamily: F.mono,
                  fontSize: 12,
                  color: C.dim,
                  padding: "4px 8px",
                  borderRadius: 6,
                  background: i < 6 ? "rgba(82, 255, 139, 0.04)" : "rgba(255, 45, 85, 0.03)",
                }}
              >
                <span style={{color: C.text}}>#{i + 1}</span>
                <span style={{color: C.text}}>{t.ticker}</span>
                <span>HP {t.hp}</span>
                <span>{t.status.toLowerCase()}</span>
                <span style={{color: i < 6 ? C.green : C.red}}>
                  {i < 6 ? "above cut" : "below cut"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </OperatorCard>
  );
}

/// Spec §47.3.2 — infrastructure health card. Today this surfaces a compact subset
/// (indexer lag, alerts count). Heartbeat / RPC CU usage / vault balances are wired
/// in v2 — flagged with `Pending` state where data isn't yet plumbed.
export function InfraHealthCard({
  alertsCount,
  indexerOk,
}: {
  alertsCount: number;
  indexerOk: boolean;
}) {
  return (
    <OperatorCard label="Infrastructure" sublabel="health" accent={C.cyan}>
      <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12}}>
        <KV k="Indexer" v={indexerOk ? "ok" : "degraded"} tone={indexerOk ? C.green : C.red} />
        <KV k="Active alerts" v={String(alertsCount)} tone={alertsCount > 0 ? C.yellow : C.dim} />
        <KV k="Scheduler heartbeat" v="pending" tone={C.faint} />
        <KV k="RPC CU usage" v="pending" tone={C.faint} />
        <KV k="Vault balances" v="pending" tone={C.faint} />
      </div>
      <p style={{margin: "10px 0 0", fontSize: 12, color: C.faint, fontFamily: F.mono}}>
        Pending sources: scheduler tick log, RPC provider quota, on-chain vault reads. v2 wires
        these via dedicated /operator/health subroutes — see spec §47.3.2.
      </p>
    </OperatorCard>
  );
}

/// Spec §47.3.3 — financial overview. Aggregated fee flows + per-season Filter Fund.
export function FinancialOverviewCard({data}: {data: FinancialOverview | null}) {
  return (
    <OperatorCard label="Financial overview" sublabel="snapshot">
      {!data ? (
        <Pending />
      ) : (
        <>
          <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12}}>
            <KV k="To vault" v={`${formatEtherTrim(data.flowsTotal.toVaultWei)} WETH`} />
            <KV k="To treasury" v={`${formatEtherTrim(data.flowsTotal.toTreasuryWei)} WETH`} />
            <KV k="To mechanics" v={`${formatEtherTrim(data.flowsTotal.toMechanicsWei)} WETH`} />
            <KV k="To creator" v={`${formatEtherTrim(data.flowsTotal.toCreatorWei)} WETH`} />
          </div>
          <div style={{marginTop: 12}}>
            <div
              style={{
                fontFamily: F.mono,
                fontSize: 11,
                color: C.faint,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Filter Fund — last {data.filterFundBySeason.length} seasons
            </div>
            <div style={{display: "flex", flexDirection: "column", gap: 4}}>
              {data.filterFundBySeason.map((s) => (
                <div
                  key={s.seasonId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "60px 1fr 1fr 1fr",
                    gap: 8,
                    fontFamily: F.mono,
                    fontSize: 12,
                    color: C.dim,
                  }}
                >
                  <span style={{color: C.text}}>#{s.seasonId}</span>
                  <span>{s.phase}</span>
                  <span>pot {formatEtherTrim(s.totalPotWei)}</span>
                  <span>bonus {formatEtherTrim(s.bonusReserveWei)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </OperatorCard>
  );
}

/// Dispatch-spec'd drift tolerance for the dashboard's red/green chip per
/// settlement-provenance row. A drift > 10s gets visually flagged so an
/// operator can spot scheduler latency before it crosses the 60s alert
/// threshold (see `SETTLEMENT_DRIFT_ALERT_SEC` in the indexer's
/// `operatorAlerts.ts` for the alert-side constant — these are deliberately
/// different surfaces and read at different cadences). Bugbot PR #95 round 12
/// (Low): pre-fix this was a bare `10` magic number with the same value
/// declared (and unused) in the indexer's operatorAlerts.ts. Source of truth
/// now lives here, where it's actually consumed.
const SETTLEMENT_DRIFT_TOLERANCE_SEC = 10;

/// Spec §47.3.4 — settlement provenance. Last N seasons' CUT/FINALIZE timestamps
/// + drift vs. the expected h96 / h168 anchors.
export function SettlementProvenanceCard({history}: {history: SettlementHistoryEntry[] | null}) {
  return (
    <OperatorCard label="Settlement provenance" sublabel="last 10">
      {!history ? (
        <Pending />
      ) : history.length === 0 ? (
        <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>No settled seasons yet.</p>
      ) : (
        <div style={{display: "flex", flexDirection: "column", gap: 4}}>
          {history.map((h) => {
            const startedSec = Number(h.startedAt);
            const expectedFinalizeSec = startedSec + 168 * 3600;
            const drift = h.finalizeAt ? Number(h.finalizeAt) - expectedFinalizeSec : null;
            const driftTone =
              drift === null
                ? C.faint
                : Math.abs(drift) > SETTLEMENT_DRIFT_TOLERANCE_SEC
                ? C.red
                : C.green;
            return (
              <div
                key={h.seasonId}
                style={{
                  display: "grid",
                  gridTemplateColumns: "70px 1fr 1fr 100px 100px",
                  gap: 8,
                  fontFamily: F.mono,
                  fontSize: 12,
                  color: C.dim,
                  padding: "4px 8px",
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                <span style={{color: C.text}}>#{h.seasonId}</span>
                <span title={h.cutAt ?? ""}>cut {h.cutAt ? "✓" : "—"}</span>
                <span title={h.finalizeAt ?? ""}>finalize {h.finalizeAt ? "✓" : "—"}</span>
                <span style={{color: driftTone}}>
                  drift {drift !== null ? `${drift}s` : "—"}
                </span>
                <span title={h.rolloverRoot ?? ""}>
                  root {h.rolloverRoot ? `${h.rolloverRoot.slice(0, 10)}…` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </OperatorCard>
  );
}

/// Spec §47.3.5 — scoring config card. Reads /scoring/weights (public endpoint;
/// no operator gate needed for the data, only the consuming UI needs to be on the
/// operator route).
export function ScoringConfigCard({
  version,
  weights,
  flags,
}: {
  version: string | null;
  weights: Record<string, number> | null;
  flags: Record<string, boolean> | null;
}) {
  return (
    <OperatorCard label="Scoring config" sublabel="locked v4">
      {!version || !weights || !flags ? (
        <Pending />
      ) : (
        <>
          <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12}}>
            <KV k="HP version" v={version} />
            {Object.entries(weights).map(([k, v]) => (
              <KV key={k} k={k} v={v.toFixed(2)} />
            ))}
          </div>
          <div style={{marginTop: 10, display: "flex", gap: 12}}>
            {Object.entries(flags).map(([k, v]) => (
              <span
                key={k}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontFamily: F.mono,
                  fontSize: 11,
                  background: v ? "rgba(82,255,139,0.12)" : "rgba(255,45,85,0.10)",
                  color: v ? C.green : C.red,
                  fontWeight: 700,
                }}
              >
                {k} = {String(v)}
              </span>
            ))}
          </div>
        </>
      )}
    </OperatorCard>
  );
}

/// Spec §47.3.6 — reservation + ticker state.
export function ReservationStateCard() {
  return (
    <OperatorCard label="Reservations + tickers" sublabel="snapshot">
      <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>
        Active reservations + ticker blocklist + winner reservations are surfaced via the public
        <code style={{fontFamily: F.mono, color: C.text, padding: "0 4px"}}>/season/:id/launch-status</code>
        and the protocol-blocklist seed (read directly from the launcher contract). The operator
        action below covers append-to-blocklist; cross-season reservations are read-only.
      </p>
    </OperatorCard>
  );
}

/// Spec §47.3.7 — bag-lock surface. Active bag-lock commitments + locks expiring in next 7d.
export function BagLockSurfaceCard({tokens}: {tokens: TokenResponse[] | null}) {
  if (!tokens) {
    return (
      <OperatorCard label="Bag-lock surface" sublabel="snapshot">
        <Pending />
      </OperatorCard>
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const sevenDaysSec = 7 * 24 * 3600;
  const locked = tokens.filter((t) => t.bagLock.isLocked && t.bagLock.unlockTimestamp);
  const expiringSoon = locked.filter(
    (t) =>
      t.bagLock.unlockTimestamp! > nowSec &&
      t.bagLock.unlockTimestamp! - nowSec < sevenDaysSec,
  );
  return (
    <OperatorCard label="Bag-lock surface" sublabel="snapshot">
      <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12}}>
        <KV k="Locked tokens" v={String(locked.length)} />
        <KV
          k="Expiring < 7d"
          v={String(expiringSoon.length)}
          tone={expiringSoon.length > 0 ? C.yellow : C.dim}
        />
      </div>
      {expiringSoon.length > 0 && (
        <div style={{marginTop: 10, display: "flex", flexDirection: "column", gap: 4}}>
          {expiringSoon.map((t) => {
            const remainingSec = t.bagLock.unlockTimestamp! - nowSec;
            const daysLeft = (remainingSec / 86_400).toFixed(1);
            return (
              <div
                key={t.token}
                style={{fontFamily: F.mono, fontSize: 12, color: C.dim, display: "flex", gap: 12}}
              >
                <span style={{color: C.text}}>{t.ticker}</span>
                <span>creator {t.bagLock.creator.slice(0, 8)}…</span>
                <span style={{color: C.yellow}}>{daysLeft}d left</span>
              </div>
            );
          })}
        </div>
      )}
    </OperatorCard>
  );
}

/// Spec §47.3.8 — Filter Club card. Renders the placeholder per Epic 2.6 not-yet-shipped
/// guidance from the dispatch.
export function FilterClubCard() {
  return (
    <OperatorCard label="Filter Club" sublabel="placeholder">
      <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>
        Not available — depends on Epic 2.6 (Filter Club mint). Mint progress, audit-budget
        allocation, and the holder roster will surface here once 2.6 ships.
      </p>
    </OperatorCard>
  );
}

/// Spec §47.7 — operator action audit log card. Filterable by actor/action.
export function ActionAuditCard({rows}: {rows: OperatorActionRow[] | null}) {
  return (
    <OperatorCard label="Action audit log" sublabel="OperatorActionEmitted + TickerBlocked">
      {!rows ? (
        <Pending />
      ) : rows.length === 0 ? (
        <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>
          No operator actions logged on this deployment yet.
        </p>
      ) : (
        <div style={{display: "flex", flexDirection: "column", gap: 4}}>
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: "grid",
                gridTemplateColumns: "150px 180px 1fr 100px",
                gap: 8,
                fontFamily: F.mono,
                fontSize: 12,
                color: C.dim,
                padding: "4px 8px",
                borderRadius: 6,
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <span style={{color: C.text}}>{r.action}</span>
              <span title={r.actor}>{r.actor.slice(0, 10)}…</span>
              <span title={r.params}>{r.params.slice(0, 30)}…</span>
              <span>{new Date(Number(r.blockTimestamp) * 1000).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </OperatorCard>
  );
}

// ============================================================ shared helpers

function KV({k, v, tone}: {k: string; v: string; tone?: string}) {
  return (
    <div>
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 10,
          color: C.faint,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {k}
      </div>
      <div style={{fontFamily: F.display, fontSize: 16, fontWeight: 700, color: tone ?? C.text}}>
        {v}
      </div>
    </div>
  );
}

function Pending() {
  return (
    <p style={{margin: 0, fontSize: 13, color: C.faint, fontFamily: F.mono}}>
      Loading…
    </p>
  );
}

function formatEtherTrim(wei: string): string {
  try {
    const v = formatEther(BigInt(wei));
    // Trim trailing zeros + a trailing dot for compactness
    return v.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  } catch {
    return wei;
  }
}
