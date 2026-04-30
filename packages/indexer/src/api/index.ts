/// HTTP API routes — Epic 1.3 part 1/3.
///
/// Mounts on Ponder's built-in Hono server (default port 42069) via `ponder.get`. Endpoints:
///
///   GET /season             — current season state, cadence anchors, prize pools
///   GET /tokens             — ranked cohort with HP + components + status + market data
///   GET /token/:address     — minimal per-token detail (used by the leaderboard token card)
///
/// Route handlers are intentionally thin: they translate Drizzle queries into the
/// `ApiQueries` shape and defer to pure handler functions in `./handlers.ts`. That split
/// keeps every translation step covered by vitest unit tests without requiring a running
/// Ponder instance.

import {ponder, type ApiContext} from "@/generated";
import {and, count, desc, eq} from "@ponder/core";

import {season, token} from "../../ponder.schema";

import {
  getSeasonHandler,
  getTokenDetailHandler,
  getTokensHandler,
  type ApiQueries,
  type TokenDetailRow,
} from "./handlers.js";

ponder.get("/season", async (c) => {
  const result = await getSeasonHandler(buildQueries(c.db));
  return c.json(result.body, result.status as 200 | 404);
});

ponder.get("/tokens", async (c) => {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const result = await getTokensHandler(buildQueries(c.db), nowSec);
  return c.json(result.body, result.status as 200);
});

ponder.get("/token/:address", async (c) => {
  const result = await getTokenDetailHandler(buildQueries(c.db), c.req.param("address") ?? "");
  return c.json(result.body, result.status as 200 | 400 | 404);
});

/// Adapts the Ponder `c.db` Drizzle handle into the database-agnostic `ApiQueries`
/// interface that pure handlers consume. The handlers don't care which schema columns or
/// where-clauses we use — they just take rows in and JSON out — so this mapping is the
/// only place that knows about Drizzle / Ponder.
function buildQueries(db: ApiDb): ApiQueries {
  return {
    latestSeason: async () => {
      const rows = await db.select().from(season).orderBy(desc(season.id)).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        startedAt: row.startedAt,
        phase: row.phase,
        totalPot: row.totalPot,
        bonusReserve: row.bonusReserve,
      };
    },
    publicLaunchCount: async (seasonId) => {
      const rows = await db
        .select({n: count()})
        .from(token)
        .where(and(eq(token.seasonId, seasonId), eq(token.isProtocolLaunched, false)));
      return Number(rows[0]?.n ?? 0);
    },
    tokensInSeason: async (seasonId) => {
      const rows = await db.select().from(token).where(eq(token.seasonId, seasonId));
      return rows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        isFinalist: r.isFinalist,
        liquidated: r.liquidated,
        liquidationProceeds: r.liquidationProceeds,
      }));
    },
    tokenByAddress: async (addr) => {
      const rows = await db.select().from(token).where(eq(token.id, addr)).limit(1);
      const row = rows[0];
      if (!row) return null;
      const detail: TokenDetailRow = {
        id: row.id,
        symbol: row.symbol,
        isFinalist: row.isFinalist,
        liquidated: row.liquidated,
        liquidationProceeds: row.liquidationProceeds,
        name: row.name,
        seasonId: row.seasonId,
        isProtocolLaunched: row.isProtocolLaunched,
      };
      return detail;
    },
  };
}

/// Local alias for Ponder's API context db handle.
type ApiDb = ApiContext["db"];
