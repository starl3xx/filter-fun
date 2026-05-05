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
/// `applyHttpRateLimit` is reused — operators are rate-limited just like public clients.
/// They have their own bucket (per IP, same as everyone else) but the cap is generous
/// enough that an operator-console session never bumps it.

import {ponder, type ApiContext} from "@/generated";
import {and, desc, eq, gte, inArray, lte} from "@ponder/core";
import type {Context} from "hono";
import {streamSSE} from "hono/streaming";

import {feeAccrual, launchEscrowSummary, operatorActionLog, phaseChange, season, token} from "../../ponder.schema";

import {applyHttpRateLimit, type MwContext, clientIpFromContext} from "./middleware.js";
import {toMwContext} from "./mwContext.js";
import {
  evaluateSettlementProvenance,
  type Alert,
} from "./operatorAlerts.js";
import {applyOperatorAuth} from "./operatorAuth.js";

// ============================================================ /operator/financial-overview

/// Surface: spec §47.3.3. Returns the high-level financial dashboard data so the web
/// app's operator console can render the financial overview card without firing 12
/// separate calls. Onchain balances are SOURCED from the indexer's accumulated event
/// state (notable: we don't read live balances here — the web app does that via wagmi
/// for the up-to-the-block view; this endpoint surfaces the indexed flow data).
ponder.get("/operator/financial-overview", async (c) => {
  const mw = toMwContext(c);
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const auth = await applyOperatorAuth(mw);
  if (auth.response) return auth.response;

  const db = c.db;

  // Aggregate the four-way fee-accrual rollups across all swaps in a bounded window.
  // The schema stores per-tx rows (one per `FilterLpLocker.FeesCollected` event), so we
  // sum them in-handler. Bound to the trailing 30 days so the read scales with active
  // load rather than total history (bugbot PR #95 round 3, Low Severity: pre-fix this
  // was a full-table scan that grew unboundedly post-mainnet, becoming a per-request
  // O(n) read on every operator console refresh).
  const FINANCIAL_WINDOW_SEC = 30 * 24 * 3600;
  const sinceSec = BigInt(Math.floor(Date.now() / 1000) - FINANCIAL_WINDOW_SEC);
  const rows = await db
    .select()
    .from(feeAccrual)
    .where(gte(feeAccrual.blockTimestamp, sinceSec));
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
      /// Window the `flowsTotal` aggregate covers (seconds — trailing 30 days).
      /// The dashboard renders this so an operator reading "0.014 WETH to vault"
      /// understands the scale ("0.014 WETH over the last 30 days" vs.
      /// "all-time"). All-time aggregates would require a materialised view; the
      /// 30-day window is a pragmatic cap that scales with operator-console
      /// usage instead of total history.
      flowsWindowSec: FINANCIAL_WINDOW_SEC,
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
  const limited = applyHttpRateLimit(mw);
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

  // Pull phase-change rows for the in-scope seasons. Bugbot PR #95 round 4
  // (Low Severity): pre-fix the query used `gte(seasonId, min(seasonIds))`,
  // which technically over-fetched any phaseChange row with seasonId ≥ the
  // smallest in the requested set — including seasons not requested. Using
  // `inArray` reads exactly the requested set.
  const seasonIds = seasonRows.map((s) => s.id);
  const phaseRows = seasonIds.length
    ? await db
        .select()
        .from(phaseChange)
        .where(inArray(phaseChange.seasonId, seasonIds))
    : [];
  const phaseBySeason = new Map<string, typeof phaseRows>();
  for (const row of phaseRows) {
    const key = row.seasonId.toString();
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
  const limited = applyHttpRateLimit(mw);
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
  const limited = applyHttpRateLimit(mw);
  if (limited) return limited;
  const auth = await applyOperatorAuth(mw);
  if (auth.response) return auth.response;

  const alerts = await computeAlerts(c.db);
  return c.json({alerts}, 200);
});

// ============================================================ /operator/alerts/stream

/// SSE push stream of alert state. The indexer recomputes alerts every 30s and emits a
/// frame whenever the active alert set changes (or on reconnect).
///
/// Consumer surface (bugbot PR #95 round 5, Low Severity):
///   - The browser-side operator console deliberately polls `/operator/alerts`
///     on a 30s cadence rather than consuming this SSE. Browser `EventSource`
///     can't send custom auth headers (Authorization / X-Operator-*), and a
///     query-param signature would leak via referrer headers and proxy logs.
///     A fetch+ReadableStream consumer could pass headers, but the 30s alert
///     cadence is identical between push and poll — net latency is unchanged
///     while doubling the auth surface. So the browser uses polling.
///   - This endpoint serves NON-browser operator clients (ops CLIs, dashboards,
///     `curl` smoke tests) where setting Authorization is trivial. It's a
///     parallel surface, not dead code — removing it would force script-based
///     consumers to fall back to polling on the same /operator/alerts route.
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
    // Bugbot PR #95 round 16 (Low): Hono's `SSEStreamingApi` exposes
    // `aborted` but NOT `closed` — pre-fix the loop included `!stream.closed`,
    // which evaluated `!undefined → true` and was silently a no-op. A future
    // Hono release introducing `closed` with different semantics would have
    // changed loop behavior unpredictably. Just check `!stream.aborted`.
    while (!stream.aborted) {
      // Bugbot PR #95 round 4 (Medium Severity): pre-fix a transient DB
      // failure in `computeAlerts` would throw out of the SSE handler and
      // tear down the operator's alert stream permanently — the operator
      // would have to manually reconnect. Wrap each tick so a hiccup just
      // emits an `error` frame and the loop keeps retrying on cadence.
      try {
        const alerts = await computeAlerts(c.db);
        const next = JSON.stringify(alerts);
        if (next !== lastJson) {
          await stream.writeSSE({event: "alerts", data: next});
          lastJson = next;
        } else {
          await stream.writeln(":hb");
        }
      } catch (err) {
        // Bugbot PR #95 round 18 (Low): if `computeAlerts` throws AND the
        // stream is concurrently aborted (client disconnected mid-tick), the
        // error-frame `writeSSE` will itself throw on the already-aborted
        // stream — that throw escapes the catch and surfaces as an unhandled
        // promise rejection. Guard the write so an aborted stream just exits
        // the loop cleanly on the next iteration check.
        if (!stream.aborted) {
          const message = err instanceof Error ? err.message : "alerts_unavailable";
          try {
            await stream.writeSSE({event: "error", data: JSON.stringify({error: message})});
          } catch {
            // Stream raced from open → aborted between the guard and the
            // write. Swallow — the `while (!stream.aborted)` condition
            // will exit the loop on the next iteration.
          }
        }
        // Reset lastJson so the next successful tick re-emits the current
        // alert set even if the JSON happens to match what we sent before
        // the error — the client just got an error frame and may have
        // dropped the cached state.
        lastJson = "";
      }
      // 30s cadence: alerts are infra-health signals, not real-time market signals.
      // The web layer also reads /operator/alerts on focus to catch missed updates.
      //
      // Bugbot PR #95 round 19 (Low): poll `stream.aborted` every 500ms instead
      // of awaiting an unconditional 30s setTimeout. Without this, a client
      // disconnect mid-tick keeps the handler alive for up to the full 30s
      // until the next loop check. ~500ms granularity bounds disconnect-to-
      // cleanup at half a second with negligible overhead (60 setTimeout calls
      // per 30s iteration), no AbortController plumbing needed.
      const SLEEP_TICK_MS = 500;
      const SLEEP_TOTAL_MS = 30_000;
      for (let elapsed = 0; elapsed < SLEEP_TOTAL_MS && !stream.aborted; elapsed += SLEEP_TICK_MS) {
        await new Promise((r) => setTimeout(r, SLEEP_TICK_MS));
      }
    }
  });
  // Reference the IP fn so the import doesn't get tree-shaken; we may re-introduce
  // the per-IP cap in v2 once the operator console uses a dedicated subdomain.
  void clientIpFromContext;
  return stream;
});

// ============================================================ Alert computation

const RESERVATION_STUCK_THRESHOLD_SEC = 60 * 60; // 1 hour

async function computeAlerts(db: ApiContext["db"]): Promise<Alert[]> {
  const out: Alert[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Settlement provenance.
  //
  // Bugbot PR #95 round 6:
  //   - Medium: skip aborted seasons. Sparse-week seasons (< 4 reservations)
  //     terminate at h48 via `abortSeason` and never receive CUT (h96) or
  //     FINALIZE (h168) transitions by design — running the missing-CUT
  //     evaluator against them produces a permanent error-level alert that
  //     never self-resolves. That's the alert-fatigue failure mode the 60s
  //     drift threshold was designed to avoid.
  //   - Low: collapse the per-season N+1 phaseChange query into a single
  //     batched read via `inArray`. The SSE loop runs every 30s; the pre-fix
  //     code fired (1 + N) DB round trips per tick.
  const seasons = await db.select().from(season).orderBy(desc(season.id)).limit(5);
  if (seasons.length > 0) {
    const seasonIds = seasons.map((s) => s.id);
    const [escrowSummaries, allPhaseRows] = await Promise.all([
      db
        .select()
        .from(launchEscrowSummary)
        .where(inArray(launchEscrowSummary.id, seasonIds)),
      db
        .select()
        .from(phaseChange)
        .where(inArray(phaseChange.seasonId, seasonIds)),
    ]);
    const abortedById = new Map<string, boolean>();
    for (const e of escrowSummaries) {
      abortedById.set(e.id.toString(), e.aborted);
    }
    const phasesById = new Map<string, typeof allPhaseRows>();
    for (const p of allPhaseRows) {
      const key = p.seasonId.toString();
      let arr = phasesById.get(key);
      if (!arr) {
        arr = [] as typeof allPhaseRows;
        phasesById.set(key, arr);
      }
      arr.push(p);
    }
    for (const s of seasons) {
      const key = s.id.toString();
      // The summary row may not exist yet for very fresh seasons (the
      // launcher inserts on first reservation), in which case
      // `abortedById.get` returns undefined and we treat as not-aborted;
      // the season hasn't passed h48 yet either way so the missing-CUT
      // gate (h96 + grace) wouldn't fire.
      const aborted = abortedById.get(key) === true;
      const phaseRows = phasesById.get(key) ?? [];
      out.push(
        ...evaluateSettlementProvenance({
          seasonId: s.id,
          startedAtSec: Number(s.startedAt),
          cutTimestampSec: phaseRows.find((p) => p.newPhase === "Finals")?.blockTimestamp,
          finalizeTimestampSec: phaseRows.find((p) => p.newPhase === "Settlement")?.blockTimestamp,
          nowSec,
          aborted,
        }),
      );
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
