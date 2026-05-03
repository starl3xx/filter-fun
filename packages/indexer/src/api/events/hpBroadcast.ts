/// HP_UPDATED broadcast bridge — Epic 1.17b compute pathway.
///
/// Ponder event handlers (V4PoolManager.Swap, FilterToken.Transfer, the
/// HpSnapshot block-tick) all call `recomputeAndStampHp` to write
/// `hpSnapshot` rows. To turn each row into a live SSE frame, the handler
/// passes its results to `broadcastHpUpdated`, which fans the events out
/// through the same `Hub` instance that the `/events` route subscribes to.
///
/// **Why a separate module from `events/index.ts`?** That file registers
/// `ponder.get("/events", ...)` at module-eval time — importing it from a
/// Ponder handler would re-trigger route registration. This module holds a
/// settable hub reference so the route module can wire the singleton in
/// without exposing the route side-effects to handler imports.
///
/// **ID space.** The route module shares its monotonic event-id counter
/// with this broadcaster (set via `setHpBroadcastNextId`), so HP_UPDATED
/// frames and TickEngine-emitted frames advance the same sequence —
/// preserving SSE `id:` monotonicity for any future `Last-Event-ID` resume
/// support.

import {emitHpUpdated, type HpRecomputeWriteResult} from "../hpRecomputeWriter.js";
import type {Hub} from "./hub.js";

let hub: Hub | null = null;
let nextEventId: () => number = (() => {
  let n = 1;
  return () => n++;
})();

/// Wire the singleton Hub used by the SSE route. Called once at API
/// module load (see `events/index.ts`). If a handler fires before this
/// is set (rare — handlers run inside the same process as the API), the
/// broadcast is a no-op rather than a throw, preserving handler liveness.
export function setHpBroadcastHub(h: Hub): void {
  hub = h;
}

/// Wire the shared monotonic id source. Optional — when not set, HP_UPDATED
/// frames use a private counter starting at 1 (acceptable for genesis
/// where SSE has no replay buffer).
export function setHpBroadcastNextId(fn: () => number): void {
  nextEventId = fn;
}

/// Broadcast HP_UPDATED frames for the given writes. Idempotent on empty
/// input. Caller (`recomputeAndStampHp` via the `onWritten` hook) supplies
/// the ticker map; this module owns the hub + id source.
export function broadcastHpUpdated(
  written: ReadonlyArray<HpRecomputeWriteResult>,
  tickerByAddress: ReadonlyMap<string, string>,
): void {
  if (!hub || written.length === 0) return;
  emitHpUpdated(written, {
    tickerByAddress,
    isoNow: new Date().toISOString(),
    nextId: nextEventId,
    broadcast: (events) => hub!.broadcast(events),
  });
}
