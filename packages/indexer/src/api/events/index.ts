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

import {loadConfigFromEnv} from "./config.js";
import {Hub} from "./hub.js";
import {TickEngine, type EventsQueries} from "./tick.js";
import type {FeeAccrualRow} from "./types.js";

const cfg = loadConfigFromEnv();
const hub = new Hub({perConnQueueMax: cfg.perConnQueueMax});

/// Engine is started lazily on the first SSE request — Ponder's API context doesn't exist
/// at module-import time (the Drizzle handle is only valid inside route handlers), so we
/// defer construction until we have a `c.db` to plumb into the queries adapter.
let engine: TickEngine | null = null;

ponder.get("/events", (c) => {
  ensureEngineStarted(c.db);
  // Ponder's typed context narrows the Hono generics; streamSSE wants the wide form.
  return streamSSE(c as unknown as Context, async (stream) => {
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
    }
  });
});

/// Construct + start the engine on first request. Subsequent calls no-op.
function ensureEngineStarted(db: ApiContext["db"]): void {
  if (engine) return;
  engine = new TickEngine({cfg, queries: buildQueries(db), hub});
  engine.start();
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
    cumulativeFeesByToken: async (seasonId) => {
      // The `feeAccrual.token` column stores the LOCKER address (per-token locker is the
      // emitter), not the token contract — we'd need to resolve via `token.locker` to map
      // back. The current schema doesn't index a locker→token mapping in the API path,
      // so for genesis we sum all fees by emitter and let the route consumer match by
      // locker address. For now this returns an empty map — large-trade and volume-spike
      // detectors fall back to the recent-fees-only path (which is what they actually
      // need).
      // TODO(events part 3): index a locker→token mapping to populate this properly.
      void seasonId;
      return new Map();
    },
    recentFees: async (sinceSec) => {
      const rows = await db
        .select()
        .from(feeAccrual)
        .where(gte(feeAccrual.blockTimestamp, sinceSec));
      return rows.map(
        (r): FeeAccrualRow => ({
          tokenAddress: r.token,
          totalFeeWei: r.toVault + r.toTreasury + r.toMechanics,
          blockTimestampSec: r.blockTimestamp,
        }),
      );
    },
    baselineFees: async (sinceSec, baselineWindowSec) => {
      const start = sinceSec - baselineWindowSec;
      const rows = await db
        .select()
        .from(feeAccrual)
        .where(and(gte(feeAccrual.blockTimestamp, start), lte(feeAccrual.blockTimestamp, sinceSec)));
      const acc = new Map<`0x${string}`, bigint>();
      for (const r of rows) {
        const sum = r.toVault + r.toTreasury + r.toMechanics;
        acc.set(r.token, (acc.get(r.token) ?? 0n) + sum);
      }
      return acc;
    },
  };
}

/// Exposed for tests: clears the singleton so a fresh hub/engine can be wired in.
export function __resetEventsEngineForTests(): void {
  engine?.stop();
  engine = null;
}
