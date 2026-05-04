/// HP recompute writer — Epic 1.17b compute pathway.
///
/// Bridges Ponder event handlers to the pure recompute primitive in
/// `hpRecompute.ts`. This module owns:
///   - cohort recompute via `scoreCohort`
///   - hpSnapshot row write via Drizzle
///   - SSE HP_UPDATED broadcast via the events hub
///   - per-token 1s coalescing implemented in SQL (block-time window)
///
/// **Coalescing in Ponder handlers.** A naive setTimeout-based debouncer
/// doesn't work in handler context — the Drizzle `context.db` is transaction-
/// scoped and won't be valid by the time a deferred timer fires. Instead we
/// pre-check the snapshot table: if a row already exists for `(token, ts ≥
/// blockTimestamp - 1s)`, skip the new write entirely. This handles both
/// historical sync (where time is block-time and 100 swaps in one block
/// collapse via the unique-key collision on `${token}:${ts}`) and real-time
/// mode (where time approximates wall-clock).

import {and, desc, eq, gte} from "@ponder/core";

import {hpSnapshot, season, token as tokenTable} from "../../ponder.schema";
import {tickerWithDollar} from "./builders.js";
import {scoreCohortFromContext} from "./hp.js";
import {
  buildHpSnapshotInsert,
  buildHpUpdatedEvent,
  isCohortWideTrigger,
  type HpRecomputeTrigger,
} from "./hpRecompute.js";
import {toApiPhase} from "./phase.js";

export interface HpRecomputeContext {
  /// Token whose state changed (SWAP / HOLDER_SNAPSHOT). For cohort-wide
  /// triggers, the token argument is ignored — a row is written for every
  /// token in the cohort.
  tokenAddress: `0x${string}`;
  trigger: HpRecomputeTrigger;
  blockNumber: bigint;
  blockTimestamp: bigint;
  /// Optional broadcast hook. When provided, called once after all rows
  /// are inserted with the per-write payload + a `tickerByAddress` map
  /// derived from the tokens we already loaded for the cohort. The hook
  /// is intentionally opaque to the writer — production wires it to
  /// `broadcastHpUpdated` in `api/events/hpBroadcast.ts`; tests can pass
  /// a noop or a spy.
  onWritten?: (
    written: ReadonlyArray<HpRecomputeWriteResult>,
    tickerByAddress: ReadonlyMap<string, string>,
  ) => void;
}

/// Coalescing window in seconds. A swap whose blockTimestamp is within this
/// many seconds of an existing hpSnapshot row for the same token is skipped.
/// Spec §6.8 — 1s coalescing window matches the latency-budget design.
export const COALESCE_WINDOW_SEC = 1n;

export interface HpRecomputeWriteResult {
  token: `0x${string}`;
  rank: number;
  hp: number;
  trigger: HpRecomputeTrigger;
  scored: import("@filter-fun/scoring").ScoredToken;
  blockTimestamp: bigint;
}

/// Re-runs the HP score for the affected cohort and writes one hpSnapshot
/// row per token. Per-token triggers (SWAP, HOLDER_SNAPSHOT) write only the
/// affected token; cohort-wide triggers write all tokens.
///
/// Returns the list of writes (token, hp, scored, blockTimestamp) so the
/// caller can chain SSE emission. Returns empty array on coalesce-skip.
///
/// `context` is the Ponder handler context (loosely typed to keep this
/// module callsite-agnostic — the handler signatures all share the
/// db.sql.select / db.insert shape).
export async function recomputeAndStampHp(
  context: any,
  args: HpRecomputeContext,
): Promise<HpRecomputeWriteResult[]> {
  // Coalesce: per-token triggers skip if a recent row already exists.
  if (!isCohortWideTrigger(args.trigger)) {
    const recent = await context.db.sql
      .select()
      .from(hpSnapshot)
      .where(
        and(
          eq(hpSnapshot.token, args.tokenAddress),
          gte(hpSnapshot.snapshotAtSec, args.blockTimestamp - COALESCE_WINDOW_SEC),
        ),
      )
      .limit(1);
    if (recent.length > 0) return [];
  }

  // Resolve current season + cohort.
  const seasonRows = await context.db.sql
    .select()
    .from(season)
    .orderBy(desc(season.id))
    .limit(1);
  const seasonRow = seasonRows[0];
  if (!seasonRow) return [];

  const tokens = await context.db.sql
    .select()
    .from(tokenTable)
    .where(eq(tokenTable.seasonId, seasonRow.id));
  if (tokens.length === 0) return [];

  const apiPhase = toApiPhase(seasonRow.phase);
  const scored = await scoreCohortFromContext(
    context,
    tokens.map(
      (t: {id: `0x${string}`; liquidationProceeds: bigint | null; createdAt: bigint}) => ({
        id: t.id,
        liquidationProceeds: t.liquidationProceeds,
        // Epic 1.18: plumb `createdAt` through as the tie-break key.
        createdAt: t.createdAt,
      }),
    ),
    apiPhase,
    args.blockTimestamp,
  );

  const cohortWide = isCohortWideTrigger(args.trigger);
  const targets = cohortWide
    ? tokens.map((t: {id: `0x${string}`}) => t.id)
    : [args.tokenAddress];
  const written: HpRecomputeWriteResult[] = [];
  for (const tokenAddr of targets) {
    const s = scored.get(tokenAddr.toLowerCase());
    if (!s) continue;
    const row = buildHpSnapshotInsert({
      scored: s,
      trigger: args.trigger,
      apiPhase,
      blockNumber: args.blockNumber,
      blockTimestamp: args.blockTimestamp,
    });
    await context.db.insert(hpSnapshot).values(row);
    written.push({
      token: tokenAddr,
      rank: s.rank,
      hp: row.hp,
      trigger: args.trigger,
      scored: s,
      blockTimestamp: args.blockTimestamp,
    });
  }

  // Bridge to SSE: build a ticker map from the cohort we already loaded,
  // hand the writes to the broadcast hook. Caller (handler) decides
  // whether to wire it; production handlers all do.
  if (args.onWritten && written.length > 0) {
    const tickerByAddress = new Map<string, string>();
    for (const t of tokens as Array<{id: `0x${string}`; symbol: string}>) {
      tickerByAddress.set(t.id.toLowerCase(), tickerWithDollar(t.symbol));
    }
    args.onWritten(written, tickerByAddress);
  }
  return written;
}

/// Broadcasts HP_UPDATED events for the rows produced by
/// `recomputeAndStampHp`. Separated so handler-side code can choose whether
/// to emit (in genesis we always emit; live deployments may suppress on
/// cohort-wide triggers to save bandwidth).
///
/// `nextId` is the monotonic id source from the events hub —
/// implementations like `TickEngine` already maintain one. `tickerByAddress`
/// resolves token contract → display ticker (e.g. `$EDGE`); missing entries
/// emit an empty token string (clients can still join via `address`).
export function emitHpUpdated(
  written: ReadonlyArray<HpRecomputeWriteResult>,
  ctx: {
    tickerByAddress: ReadonlyMap<string, string>;
    isoNow: string;
    nextId: () => number;
    broadcast: (events: ReadonlyArray<import("./events/types.js").TickerEvent>) => void;
  },
): void {
  if (written.length === 0) return;
  const events = written.map((w) =>
    buildHpUpdatedEvent({
      id: ctx.nextId(),
      tokenAddress: w.token,
      ticker: ctx.tickerByAddress.get(w.token.toLowerCase()) ?? "",
      scored: w.scored,
      trigger: w.trigger,
      computedAtSec: w.blockTimestamp,
      isoNow: ctx.isoNow,
    }),
  );
  ctx.broadcast(events);
}
