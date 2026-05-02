/// SSE route + tick-engine bootstrap.
///
/// `GET /events` is a Server-Sent-Events stream of `TickerEvent` JSON payloads. Each
/// event is written as a single SSE record:
///
///   id: <numeric>
///   event: ticker
///   data: <json>
///
/// Clients use the standard EventSource API; the browser handles auto-reconnect and
/// `Last-Event-ID` resume on its own (we don't yet keep a server-side replay buffer, so
/// reconnects miss any events delivered during the disconnect — acceptable for genesis).
///
/// A heartbeat comment line is emitted every `cfg.heartbeatMs` so reverse-proxy idle
/// timeouts don't drop a quiet stream.
///
/// The single tick-engine instance is created + started once at module import. SSE-route
/// invocations subscribe to its hub.

import {ponder, type ApiContext} from "@/generated";
import {and, desc, eq, gte, lte} from "@ponder/core";
import type {Context} from "hono";
import {streamSSE} from "hono/streaming";

import {feeAccrual, season, token} from "../../../ponder.schema";

import {
  clientIpFromContext,
  releaseEventsConn,
  tryClaimEventsConn,
  type MwContext,
} from "../middleware.js";

import {loadConfigFromEnv} from "./config.js";
import {aggregateFeesByToken, lockerToTokenMap, translateFeeRows} from "./feeAdapter.js";
import {Hub} from "./hub.js";
import {TickEngine, type EventsQueries} from "./tick.js";

const cfg = loadConfigFromEnv();
const hub = new Hub({perConnQueueMax: cfg.perConnQueueMax});

/// Engine is started lazily on the first SSE request — Ponder's API context doesn't exist
/// at module-import time (the Drizzle handle is only valid inside route handlers), so we
/// defer construction until we have a `c.db` to plumb into the queries adapter.
let engine: TickEngine | null = null;

ponder.get("/events", (c) => {
  // Per-IP connection cap. SSE is long-lived, so we count active streams instead of
  // running this through the GET token bucket — a single client could otherwise burn a
  // bucket's worth of capacity per minute by reconnecting. Existing streams are not
  // affected when the cap is hit; only the *new* connection is refused.
  const ip = clientIpFromContext(c as unknown as MwContext);
  const claim = tryClaimEventsConn(ip);
  if (!claim.allowed) {
    (c as unknown as MwContext).header("Retry-After", String(claim.retryAfterSec));
    return c.json(
      {error: "events connection limit reached", retryAfterSec: claim.retryAfterSec},
      429,
    );
  }
  // Engine startup + streamSSE handoff happen *after* the slot is claimed, so a throw
  // here would otherwise leak the slot — `releaseEventsConn` only runs inside the
  // `streamSSE` callback's finally block, which never fires if we never reach it. Wrap
  // the synchronous stretch in try/catch and release explicitly on failure. With
  // `engine` staying null on a constructor failure, every retry would otherwise leak
  // another slot until the per-IP cap is permanently exhausted.
  let stream: Response;
  try {
    ensureEngineStarted(c.db);
    // Ponder's typed context narrows the Hono generics; streamSSE wants the wide form.
    stream = streamSSE(c as unknown as Context, async (stream) => {
      const sub = hub.connect();
      let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
      try {
      // Idle keepalive — SSE comment line every `heartbeatMs`. Awaiting `writeSSE` inside
      // setInterval would race the main event loop, so we use a flag the loop respects.
      let pendingHeartbeat = false;
      heartbeatHandle = setInterval(() => {
        pendingHeartbeat = true;
      }, cfg.heartbeatMs);
      if (heartbeatHandle && "unref" in heartbeatHandle) {
        (heartbeatHandle as {unref: () => void}).unref();
      }

      while (!stream.aborted && !stream.closed) {
        if (pendingHeartbeat) {
          await stream.writeln(":hb"); // SSE comment — clients ignore, proxies stay alive
          pendingHeartbeat = false;
        }
        // Wait up to 1s for the next event so we can periodically check the heartbeat
        // flag during quiet stretches. The timeout is handled inside `next()` and
        // explicitly avoids leaving a stale resolver behind — events that arrive after
        // the timeout land on the queue and are picked up on the next `next()` call.
        const next = await sub.next(1_000);
        if (next === null) continue;
        await stream.writeSSE({
          id: String(next.id),
          event: "ticker",
          data: JSON.stringify(next),
        });
      }
      } finally {
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        sub.close();
        // Release the per-IP slot. Critical that this lives in `finally` so abnormal
        // closes (network drop, client refresh, server-side abort) don't leak slots and
        // eventually exhaust the cap for the IP.
        releaseEventsConn(ip);
      }
    });
  } catch (err) {
    // ensureEngineStarted (or streamSSE itself) threw before the SSE callback ran. The
    // streamSSE callback's `finally` will never execute, so we own the release here.
    releaseEventsConn(ip);
    throw err;
  }
  return stream;
});

/// Construct + start the engine on first request. Subsequent calls no-op.
///
/// Exported as `ensureEventsEngineStarted` because /readiness needs to bootstrap the
/// engine on the first probe — without that, a load balancer gating on /readiness
/// would deadlock: readiness requires the engine to be running, the engine only
/// starts on the first SSE request, but no SSE request can reach the indexer until
/// the LB lets traffic through. Bugbot finding on PR #61 (Medium severity) caught
/// the deadlock; this export is the load-bearing fix. See callers in this module
/// (the SSE route below) and src/api/index.ts (/readiness route).
export function ensureEventsEngineStarted(db: ApiContext["db"]): void {
  ensureEngineStarted(db);
}

function ensureEngineStarted(db: ApiContext["db"]): void {
  if (engine) return;
  engine = new TickEngine({cfg, queries: buildQueries(db), hub});
  engine.start();
}

/// Audit H-4 (Phase 1, 2026-05-01): /readiness reads this to gate "indexer is serving
/// real-time data". The engine is started lazily on the first SSE request, so a freshly-
/// booted indexer with zero clients will always report `false` here — that is correct:
/// readiness asks whether the live-event pipeline is up, not whether the process is up
/// (Ponder's /health covers liveness). Treat the lazy-start as expected; a
/// long-running indexer with no SSE clients is a degraded state, not a healthy one.
export function eventsEngineRunning(): boolean {
  return engine?.isRunning() ?? false;
}

function buildQueries(db: ApiContext["db"]): EventsQueries {
  return {
    latestSeason: async () => {
      const rows = await db.select().from(season).orderBy(desc(season.id)).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        seasonId: row.id,
        phase: row.phase,
        startedAtSec: row.startedAt,
        takenAtSec: BigInt(Math.floor(Date.now() / 1000)),
      };
    },
    tokensForSnapshot: async (seasonId) => {
      const rows = await db.select().from(token).where(eq(token.seasonId, seasonId));
      return rows.map((r) => ({
        address: r.id,
        symbol: r.symbol,
        isFinalist: r.isFinalist,
        liquidated: r.liquidated,
        liquidationProceeds: r.liquidationProceeds,
      }));
    },
    tokenAddressByLocker: async () => {
      // Resolve LOCKER → token contract address. The fee-accrual schema stores the
      // FilterLpLocker address (it's the FeesCollected emitter), not the token contract;
      // every fee row silently failed the downstream `tokensByAddr.get(...)` lookup in
      // detectVolumeSpike + detectLargeTrade until this resolution was added. The map is
      // fetched once per tick by the engine and shared between recentFees + baselineFees.
      const allTokens = await db.select().from(token);
      return lockerToTokenMap(allTokens);
    },
    recentFees: async (sinceSec, lockerMap) => {
      const rows = await db
        .select()
        .from(feeAccrual)
        .where(gte(feeAccrual.blockTimestamp, sinceSec));
      return translateFeeRows(rows, lockerMap);
    },
    baselineFees: async (sinceSec, baselineWindowSec, lockerMap) => {
      const start = sinceSec - baselineWindowSec;
      const rows = await db
        .select()
        .from(feeAccrual)
        .where(and(gte(feeAccrual.blockTimestamp, start), lte(feeAccrual.blockTimestamp, sinceSec)));
      return aggregateFeesByToken(rows, lockerMap);
    },
  };
}
