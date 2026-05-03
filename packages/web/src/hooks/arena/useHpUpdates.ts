"use client";

import {useMemo} from "react";

import type {HpUpdatedData, TickerEvent, TokenResponse} from "@/lib/arena/api";

/// Live HP overlay derived from the indexer's SSE stream — Epic 1.17c.
///
/// `useTickerEvents` produces a newest-first buffer of all ticker events.
/// This hook narrows it to `HP_UPDATED` frames and folds them into a
/// `Map<address, HpUpdate>` keyed by lowercase canonical address. The map
/// holds the FRESHEST update per token (by `computedAt`), so a leaderboard
/// poll that arrives between SSE frames doesn't clobber a more-recent SSE
/// update.
///
/// **Why a separate hook from `useTickerEvents`.** The activity feed and
/// ticker bar consume HIGH/MEDIUM events; the leaderboard only cares about
/// LOW HP_UPDATED frames. Splitting the consumers keeps re-renders local —
/// the leaderboard re-renders on HP changes; the activity feed doesn't.

export type HpUpdate = {
  hp: number;
  components: HpUpdatedData["components"];
  weightsVersion: string;
  computedAt: number;
  trigger: HpUpdatedData["trigger"];
  /// ISO timestamp from the SSE wire (server wall-clock at emission). Used
  /// by the "updated 3s ago" indicator on the leaderboard.
  receivedAtIso: string;
};

export type UseHpUpdatesResult = {
  /// Address (lowercase) → freshest HP_UPDATED for that token. Updates
  /// reactively as the underlying events buffer changes.
  hpByAddress: Map<string, HpUpdate>;
};

export function useHpUpdates(events: ReadonlyArray<TickerEvent>): UseHpUpdatesResult {
  const hpByAddress = useMemo(() => {
    const out = new Map<string, HpUpdate>();
    // events is newest-first; we walk it once and only insert if no fresher
    // entry exists yet for the same token (lowercase). Using `computedAt` for
    // staleness rather than buffer order means out-of-order delivery (rare but
    // possible if the SSE id source ever lags) doesn't invert the overlay.
    for (const ev of events) {
      if (ev.type !== "HP_UPDATED") continue;
      if (!ev.address) continue;
      const key = ev.address.toLowerCase();
      const data = ev.data as unknown as HpUpdatedData;
      const candidate: HpUpdate = {
        hp: data.hp,
        components: data.components,
        weightsVersion: data.weightsVersion,
        computedAt: data.computedAt,
        trigger: data.trigger,
        receivedAtIso: ev.timestamp,
      };
      const existing = out.get(key);
      if (!existing || candidate.computedAt > existing.computedAt) {
        out.set(key, candidate);
      }
    }
    return out;
  }, [events]);

  return {hpByAddress};
}

/// Merge the live HP overlay onto the polled cohort. Returns a new array of
/// tokens with the freshest HP applied per-row.
///
/// **Tie-break rule.** A live HP_UPDATED is preferred over the polled value
/// IFF its `computedAt` is at least as recent as `tokens[i].hpComputedAt`
/// (or the poll itself, when the row exposes no per-row timestamp). The
/// poll exposes a server-side `nextCutAt` but no per-row recompute time, so
/// we fall back to a permissive "live wins on any update" rule — acceptable
/// because the indexer's poll itself reads the same `hpSnapshot` table the
/// SSE writes go to (so the live frame is at worst 0–1s ahead, never behind).
///
/// The merger preserves rank from the poll. Live HP_UPDATED frames don't
/// re-rank — the indexer's `BLOCK_TICK` / `PHASE_BOUNDARY` cohort-wide
/// recomputes do, and they hit the poll path. Keeping rank polled-only
/// avoids visible re-ordering thrash from out-of-order SSE delivery.
export function mergeHpUpdates(
  tokens: ReadonlyArray<TokenResponse>,
  hpByAddress: ReadonlyMap<string, HpUpdate>,
): TokenResponse[] {
  if (hpByAddress.size === 0) return tokens.slice();
  return tokens.map((t) => {
    const live = hpByAddress.get(t.token.toLowerCase());
    if (!live) return t;
    if (live.hp === t.hp && componentsEqual(live.components, t.components)) {
      // No actual change — return the original to keep React identity stable
      // (so memoized child components don't re-render).
      return t;
    }
    return {
      ...t,
      hp: live.hp,
      // The HP_UPDATED frame carries all 6 components (incl. holderConcentration),
      // but the polled `/tokens` response surface is 5 today (audit H-1: holder-
      // concentration ships when the public holder-snapshot endpoint flips on).
      // Mirror the polled shape for the merge so TokenResponse callers stay
      // consistent — the 6th component is still available via `useHpUpdates`'
      // raw `hpByAddress` map for consumers (per-token detail panel) that want
      // it.
      components: {
        velocity: live.components.velocity,
        effectiveBuyers: live.components.effectiveBuyers,
        stickyLiquidity: live.components.stickyLiquidity,
        retention: live.components.retention,
        momentum: live.components.momentum,
      },
    };
  });
}

function componentsEqual(
  a: HpUpdatedData["components"],
  b: TokenResponse["components"],
): boolean {
  return (
    a.velocity === b.velocity &&
    a.effectiveBuyers === b.effectiveBuyers &&
    a.stickyLiquidity === b.stickyLiquidity &&
    a.retention === b.retention &&
    a.momentum === b.momentum
  );
}

/// Returns the set of addresses (lowercase) whose HP_UPDATED arrived within
/// the recency window. Drives the "just updated" pulse on the leaderboard.
/// `nowMs` is injectable for tests.
export function recentlyUpdatedAddresses(
  hpByAddress: ReadonlyMap<string, HpUpdate>,
  recencyMs: number,
  nowMs: number = Date.now(),
): Set<string> {
  const cutoff = nowMs - recencyMs;
  const out = new Set<string>();
  for (const [addr, upd] of hpByAddress) {
    const t = Date.parse(upd.receivedAtIso);
    if (Number.isFinite(t) && t >= cutoff) out.add(addr);
  }
  return out;
}
