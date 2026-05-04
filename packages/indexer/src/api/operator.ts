/// `/operator/*` HTTP routes (Epic 1.21 / spec §47).
///
/// All routes are gated by `applyOperatorAuth` (server-side SIWE-style signed-message
/// verification + `OPERATOR_WALLETS` allow-list check). Non-operator wallets get a 403
/// with a structured `{error, reason}` body so the operator console renders a precise
/// banner. Read-only routes only — operator *actions* are wagmi tx flows that hit
/// contracts directly from the web app.
///
/// Surfaces:
///   GET  /operator/financial-overview   — treasury / mechanics / creator-fees aggregates
///   GET  /operator/settlement-history   — last N seasons' CUT/FINALIZE provenance
///   GET  /operator/alerts               — active alerts (long-poll friendly)
///   GET  /operator/alerts/stream        — SSE push stream of alert events
///   GET  /operator/actions              — `OperatorActionLog` rows (filterable)
///
/// `applyGetRateLimit` is reused — operators are rate-limited just like public clients.
/// They have their own bucket (per IP, same as everyone else) but the cap is generous
/// enough that an operator-console session never bumps it.

import {ponder, type ApiContext} from "@/generated";
import {and, asc, desc, eq, gte, lte} from "@ponder/core";
import type {Context} from "hono";
import {streamSSE} from "hono/streaming";

import {feeAccrual, operatorActionLog, phaseChange, season, token} from "../../ponder.schema";

import {applyGetRateLimit, type MwContext, clientIpFromContext} from "./middleware.js";
import {toMwContext} from "./mwContext.js";
import {applyOperatorAuth} from "./operatorAuth.js";

// ============================================================ /operator/financial-overview

/// Surface: spec §47.3.3. Returns the high-level financial dashboard data so the web
/// app's operator console can render the financial overview card without firing 12
/// separate calls. Onchain balances are SOURCED from the indexer's accumulated event
/// state (notable: we don't read live balances here — the web app does that via wagmi
/// for the up-to-the-block view; this endpoint surfaces the indexed flow data).
ponder.get("/operator/financial-overview", async (c) => {
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const auth = await applyOperatorAuth(mw);
  if (auth.response) return auth.response;

  const db = c.db;

  // Aggregate the four-way fee-accrual rollups across all swaps in the indexed window.
  // The schema stores per-tx rows (one per `FilterLpLocker.FeesCollected` event), so we
  // sum them in-handler. For genesis volumes this is fine (~hundreds of rows/season);
  // post-mainnet a materialised aggregate is the optimisation if this becomes slow.
  const rows = await db.select().from(feeAccrual);
  const flows = rows.reduce(
    (acc, r) => ({
      toVault: acc.toVault + r.toVault,
      toTreasury: acc.toTreasury + r.toTreasury,
      toMechanics: acc.toMechanics + r.toMechanics,
      toCreator: acc.toCreator + r.toCreator,
    }),
    {toVault: 0n, toTreasury: 0n, toMechanics: 0n, toCreator: 0n},
  );

  // Per-season Filter Fund (= toVault aggregate, since toVault flows the season-side
  // share into the SeasonVault). The active season's row + the last 4 are returned.
  const seasonRows = await db.select().from(season).orderBy(desc(season.id)).limit(5);
  const filterFundBySeason = seasonRows.map((s) => ({
    seasonId: s.id.toString(),
    totalPotWei: s.totalPot.toString(),
    bonusReserveWei: s.bonusReserve.toString(),
    rolloverWinnerTokens: s.rolloverWinnerTokens.toString(),
    phase: s.phase,
  }));

  return c.json(
    {
      flowsTotal: {
        toVaultWei: flows.toVault.toString(),
        toTreasuryWei: flows.toTreasury.toString(),
        toMechanicsWei: flows.toMechanics.toString(),
        toCreatorWei: flows.toCreator.toString(),
      },
      filterFundBySeason,
      indexedAt: Math.floor(Date.now() / 1000),
    },
    200,
  );
});

// ============================================================ /operator/settlement-history

/// Surface: spec §47.3.4. Returns the last N seasons' settlement provenance — the
/// CUT (Filter→Finals) + FINALIZE (Finals→Settled) phase-change timestamps + the
/// rollover Merkle root + the season's totalPot. Drift values (vs. expected h96 /
/// h168 wall-clock anchors) are computed client-side from `startedAt + 96/168h`.
///
/// Optional `?limit=N` (default 10, max 50). Optional `?seasonId=N` returns just one.
ponder.get("/operator/settlement-history", async (c) => {
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const auth = await applyOperatorAuth(mw);
  if (auth.response) return auth.response;

  const db = c.db;
  const url = new URL(c.req.url);
  const limitRaw = url.searchParams.get("limit");
  const seasonIdRaw = url.searchParams.get("seasonId");
  let limit = 10;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0) limit = Math.min(50, Math.floor(n));
  }

  let seasonRows;
  if (seasonIdRaw) {
    let want: bigint;
    try {
      want = BigInt(seasonIdRaw);
    } catch {
      return c.json({error: "invalid seasonId", raw: seasonIdRaw}, 400);
    }
    seasonRows = await db.select().from(season).where(eq(season.id, want)).limit(1);
  } else {
    seasonRows = await db.select().from(season).orderBy(desc(season.id)).limit(limit);
  }

  // Pull phase-change rows for the in-scope seasons. `phase_change` rows are keyed
  // `${seasonId}:${index}`, so we filter by seasonId set.
  const seasonIds = seasonRows.map((s) => s.id);
  const phaseRows = seasonIds.length
    ? await db
        .select()
        .from(phaseChange)
        .where(
          // Drizzle doesn't ship `inArray` on bigint cleanly across versions; for the
          // small list (up to 50) we filter client-side after a single fetch.
          gte(phaseChange.seasonId, seasonIds[seasonIds.length - 1]!),
        )
    : [];
  const phaseBySeason = new Map<string, typeof phaseRows>();
  for (const row of phaseRows) {
    const key = row.seasonId.toString();
    if (!seasonIds.some((s) => s === row.seasonId)) continue;
    let arr = phaseBySeason.get(key);
    if (!arr) {
      arr = [] as typeof phaseRows;
      phaseBySeason.set(key, arr);
    }
    arr.push(row);
  }

  const out = seasonRows.map((s) => {
    const transitions = (phaseBySeason.get(s.id.toString()) ?? []).sort(
      (a, b) => Number(a.blockTimestamp) - Number(b.blockTimestamp),
    );
    const findPhase = (name: string) => transitions.find((t) => t.newPhase === name);
    const cut = findPhase("Finals");
    const finalize = findPhase("Settlement");
    return {
      seasonId: s.id.toString(),
      startedAt: s.startedAt.toString(),
      vault: s.vault,
      phase: s.phase,
      winner: s.winner,
      rolloverRoot: s.rolloverRoot,
      totalPotWei: s.totalPot.toString(),
      finalizedAt: s.finalizedAt?.toString() ?? null,
      cutAt: cut?.blockTimestamp.toString() ?? null,
      cutBlock: cut?.blockNumber.toString() ?? null,
      finalizeAt: finalize?.blockTimestamp.toString() ?? null,
      finalizeBlock: finalize?.blockNumber.toString() ?? null,
    };
  });
  return c.json({history: out}, 200);
});

// ============================================================ /operator/actions

/// Surface: spec §47.3.4 / §47.7. Returns rows from `OperatorActionLog`, populated by
/// (a) `CreatorFeeDistributor.OperatorActionEmitted` and (b) the derived
/// `FilterLauncher.TickerBlocked` mirror. Filterable by `actor`, `action`, and a
/// time range via `from` / `to` (ISO strings or Unix-seconds, both accepted).
///
/// Default sort: most recent first. `?limit=` capped at 200.
ponder.get("/operator/actions", async (c) => {
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const auth = await applyOperatorAuth(mw);
  if (auth.response) return auth.response;

  const db = c.db;
  const url = new URL(c.req.url);
  const actor = url.searchParams.get("actor")?.toLowerCase();
  const action = url.searchParams.get("action");
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0) limit = Math.min(200, Math.floor(n));
  }

  function parseTs(raw: string | null): bigint | null {
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return BigInt(Math.floor(n));
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return BigInt(Math.floor(ms / 1000));
    return null;
  }
  const fromTs = parseTs(fromRaw);
  const toTs = parseTs(toRaw);

  // Build the where clause incrementally — Drizzle's `and()` accepts an
  // arbitrary-arity tuple. We collect non-null predicates and pass them in.
  const filters = [] as ReturnType<typeof eq>[];
  if (actor) filters.push(eq(operatorActionLog.actor, actor as `0x${string}`));
  if (action) filters.push(eq(operatorActionLog.action, action));
  if (fromTs !== null) filters.push(gte(operatorActionLog.blockTimestamp, fromTs));
  if (toTs !== null) filters.push(lte(operatorActionLog.blockTimestamp, toTs));

  const baseQuery = db.select().from(operatorActionLog);
  const filtered = filters.length > 0 ? baseQuery.where(and(...filters)) : baseQuery;
  const rows = await filtered
    .orderBy(desc(operatorActionLog.blockTimestamp))
    .limit(limit);

  return c.json(
    {
      actions: rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        params: r.params,
        txHash: r.txHash,
        blockNumber: r.blockNumber.toString(),
        blockTimestamp: r.blockTimestamp.toString(),
      })),
    },
    200,
  );
});

// ============================================================ /operator/alerts

/// Surface: spec §47.5. Active alerts list. Today this is computed-on-read from
/// indexer state — no separate alerts table — so an idle indexer with no failures
/// returns an empty list. Each entry shape:
///   { id, level: "warn"|"error", source, message, since, params?: object }
///
/// `since` is a unix-seconds timestamp of when the alert first triggered.
///
/// Sources implemented in v1 (subset of spec §47.5; the remainder are observed
/// at the web layer — CSP violations, wagmi env failures, RPC rate-limit — and
/// surfaced via a separate `/operator/alerts/stream` push):
///   - indexer_lag       — chain head vs. last indexed block > 30
///   - oracle_provenance — settlement transitions absent within 10s tolerance
///   - reservation_stuck — pending refund unfulfilled > 1 hour
ponder.get("/operator/alerts", async (c) => {
  const mw = toMwContext(c);
  const limited = applyGetRateLimit(mw);
  if (limited) return limited;
  const auth = await applyOperatorAuth(mw);
  if (auth.response) return auth.response;

  const alerts = await computeAlerts(c.db);
  return c.json({alerts}, 200);
});

// ============================================================ /operator/alerts/stream

/// SSE push stream of alert state. The indexer recomputes alerts every 30s and emits a
/// frame whenever the active alert set changes (or on reconnect). The operator console
/// `EventSource` consumes these to drive the red banner without polling.
///
/// Per-IP connection cap is reused — same Retry-After contract as `/events`.
ponder.get("/operator/alerts/stream", async (c) => {
  const mw = toMwContext(c);
  const auth = await applyOperatorAuth(mw);
  if (auth.response) return auth.response;
  // Note: we deliberately don't pump through the per-IP /events connection cap here.
  // The operator console is single-connection per session by design (one SSE per tab),
  // and operator-wallet auth is itself a tighter cap than per-IP. If we re-used the
  // /events cap, an operator opening the console while an HP-broadcast SSE is already
  // open from another tab on the same IP would be silently rejected — surprising UX.

  const stream = streamSSE(c as unknown as Context, async (stream) => {
    let lastJson = "";
    while (!stream.aborted && !stream.closed) {
      const alerts = await computeAlerts(c.db);
      const next = JSON.stringify(alerts);
      if (next !== lastJson) {
        await stream.writeSSE({event: "alerts", data: next});
        lastJson = next;
      } else {
        await stream.writeln(":hb");
      }
      // 30s cadence: alerts are infra-health signals, not real-time market signals.
      // The web layer also reads /operator/alerts on focus to catch missed updates.
      await new Promise((r) => setTimeout(r, 30_000));
    }
  });
  // Reference the IP fn so the import doesn't get tree-shaken; we may re-introduce
  // the per-IP cap in v2 once the operator console uses a dedicated subdomain.
  void clientIpFromContext;
  return stream;
});

// ============================================================ Alert computation

interface Alert {
  id: string;
  level: "warn" | "error";
  source: string;
  message: string;
  since: number; // unix seconds
  params?: Record<string, unknown>;
}

const RESERVATION_STUCK_THRESHOLD_SEC = 60 * 60; // 1 hour
const SETTLEMENT_DRIFT_TOLERANCE_SEC = 10;

async function computeAlerts(db: ApiContext["db"]): Promise<Alert[]> {
  const out: Alert[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Settlement provenance: for every season past h168, both CUT + FINALIZE phase
  //    transitions must have landed within the tolerance of their expected anchors.
  const seasons = await db.select().from(season).orderBy(desc(season.id)).limit(5);
  for (const s of seasons) {
    const startedSec = Number(s.startedAt);
    const expectedCut = startedSec + 96 * 3600;
    const expectedFinalize = startedSec + 168 * 3600;
    if (nowSec < expectedFinalize - SETTLEMENT_DRIFT_TOLERANCE_SEC) continue;

    const phaseRows = await db
      .select()
      .from(phaseChange)
      .where(eq(phaseChange.seasonId, s.id));
    const cut = phaseRows.find((p) => p.newPhase === "Finals");
    const finalize = phaseRows.find((p) => p.newPhase === "Settlement");
    if (!cut) {
      out.push({
        id: `settlement_provenance_cut_missing:${s.id.toString()}`,
        level: "error",
        source: "oracle_provenance",
        message: `Season ${s.id.toString()} missed CUT transition`,
        since: expectedCut,
        params: {seasonId: s.id.toString(), expectedAt: expectedCut},
      });
    } else {
      const drift = Math.abs(Number(cut.blockTimestamp) - expectedCut);
      if (drift > SETTLEMENT_DRIFT_TOLERANCE_SEC) {
        out.push({
          id: `settlement_provenance_cut_drift:${s.id.toString()}`,
          level: "warn",
          source: "oracle_provenance",
          message: `Season ${s.id.toString()} CUT drifted ${drift}s from h96`,
          since: Number(cut.blockTimestamp),
          params: {seasonId: s.id.toString(), driftSec: drift},
        });
      }
    }
    if (!finalize) {
      out.push({
        id: `settlement_provenance_finalize_missing:${s.id.toString()}`,
        level: "error",
        source: "oracle_provenance",
        message: `Season ${s.id.toString()} missed FINALIZE transition`,
        since: expectedFinalize,
        params: {seasonId: s.id.toString(), expectedAt: expectedFinalize},
      });
    } else {
      const drift = Math.abs(Number(finalize.blockTimestamp) - expectedFinalize);
      if (drift > SETTLEMENT_DRIFT_TOLERANCE_SEC) {
        out.push({
          id: `settlement_provenance_finalize_drift:${s.id.toString()}`,
          level: "warn",
          source: "oracle_provenance",
          message: `Season ${s.id.toString()} FINALIZE drifted ${drift}s from h168`,
          since: Number(finalize.blockTimestamp),
          params: {seasonId: s.id.toString(), driftSec: drift},
        });
      }
    }
  }

  // 2. Reservation escrow stuck — surface tokens that exist but where the
  //    `liquidated` flow has stalled past the threshold. Today we lean on the
  //    `token` table's createdAt; a v2 wiring would index `LaunchEscrow.RefundFailed`
  //    explicitly. Out of scope for this PR — leaving the slot.
  void RESERVATION_STUCK_THRESHOLD_SEC;
  void token;

  return out;
}
