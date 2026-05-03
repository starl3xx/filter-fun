"use client";

import {useMemo, useRef} from "react";

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
///
/// **Identity stability.** The hook caches the result and returns the SAME
/// Map reference when the underlying HP data hasn't changed. This keeps
/// downstream `useMemo` deps stable across non-HP_UPDATED events flowing
/// through the same SSE buffer (RANK_CHANGED, FILTER_FIRED, …) — without
/// it, a flurry of unrelated events would invalidate the leaderboard's
/// `memo()` and re-fire effects that depend on `cohort`.

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
  /// reactively as the underlying events buffer changes; identity is
  /// stable across non-HP_UPDATED churn (see module docstring).
  hpByAddress: ReadonlyMap<string, HpUpdate>;
};

/// Stable empty map shared across renders so a stream with no HP_UPDATED
/// frames yet doesn't invalidate downstream memos every time `events`
/// changes for unrelated reasons.
const EMPTY_HP_MAP: ReadonlyMap<string, HpUpdate> = new Map();

export function useHpUpdates(events: ReadonlyArray<TickerEvent>): UseHpUpdatesResult {
  // Cache the previous result so we can return the SAME Map reference when
  // the HP-relevant content hasn't changed (e.g., RANK_CHANGED or
  // FILTER_FIRED arrive on the same `events` buffer but the HP map content
  // is identical).
  const prevRef = useRef<ReadonlyMap<string, HpUpdate>>(EMPTY_HP_MAP);

  const hpByAddress = useMemo<ReadonlyMap<string, HpUpdate>>(() => {
    const next = new Map<string, HpUpdate>();
    for (const ev of events) {
      if (ev.type !== "HP_UPDATED") continue;
      if (!ev.address) continue;
      const key = ev.address.toLowerCase();
      const data = ev.data as unknown as HpUpdatedData;
      const existing = next.get(key);
      if (existing && existing.computedAt >= data.computedAt) continue;
      next.set(key, {
        hp: data.hp,
        components: data.components,
        weightsVersion: data.weightsVersion,
        computedAt: data.computedAt,
        trigger: data.trigger,
        receivedAtIso: ev.timestamp,
      });
    }
    if (next.size === 0) {
      // Stable empty map — preserves identity across non-HP_UPDATED churn
      // until the first HP_UPDATED frame arrives.
      return EMPTY_HP_MAP;
    }
    if (mapsEqual(prevRef.current, next)) {
      // Same HP content — keep the previous reference so downstream memos
      // (which depend on hpByAddress identity) don't invalidate.
      return prevRef.current;
    }
    prevRef.current = next;
    return next;
  }, [events]);

  return {hpByAddress};
}

function mapsEqual(
  a: ReadonlyMap<string, HpUpdate>,
  b: ReadonlyMap<string, HpUpdate>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) return false;
    // Compare every field that downstream consumers read. `computedAt`
    // alone is *almost* enough because the indexer's SQL coalescing skips
    // re-writes for the same `(token, blockTimestamp)` — but this guards
    // defensively against same-computedAt frames carrying different
    // component scores (e.g., a cohort-wide trigger and a SWAP trigger
    // landing on identical block timestamps), which would otherwise
    // silently elide the second frame and leave detail panels showing
    // stale component breakdowns. Bugbot L on PR #83.
    if (
      va.computedAt !== vb.computedAt ||
      va.hp !== vb.hp ||
      va.trigger !== vb.trigger ||
      va.receivedAtIso !== vb.receivedAtIso ||
      va.components.velocity !== vb.components.velocity ||
      va.components.effectiveBuyers !== vb.components.effectiveBuyers ||
      va.components.stickyLiquidity !== vb.components.stickyLiquidity ||
      va.components.retention !== vb.components.retention ||
      va.components.momentum !== vb.components.momentum ||
      va.components.holderConcentration !== vb.components.holderConcentration
    ) {
      return false;
    }
  }
  return true;
}

/// Merge the live HP overlay onto the polled cohort.
///
/// **Identity contract.** Returns the input `tokens` array reference when no
/// row's HP/components actually changed. This keeps `cohort` stable across
/// HP_UPDATED frames that match what the poll already had (the indexer's
/// poll reads the same hpSnapshot table the SSE writes go to, so the
/// frequent case is "live frame == poll value, no merge needed"). Without
/// this, every SSE event would invalidate the leaderboard's `memo()`.
///
/// **Rank preservation.** The merger preserves rank from the poll. Live
/// HP_UPDATED frames don't re-rank — the indexer's `BLOCK_TICK` /
/// `PHASE_BOUNDARY` cohort-wide recomputes do, and they hit the poll path.
/// Keeping rank polled-only avoids visible re-ordering thrash from
/// out-of-order SSE delivery.
export function mergeHpUpdates(
  tokens: ReadonlyArray<TokenResponse>,
  hpByAddress: ReadonlyMap<string, HpUpdate>,
): TokenResponse[] {
  if (hpByAddress.size === 0) return tokens as TokenResponse[];
  let mutated = false;
  const out = tokens.map((t) => {
    const live = hpByAddress.get(t.token.toLowerCase());
    if (!live) return t;
    if (live.hp === t.hp && componentsEqual(live.components, t.components)) {
      return t;
    }
    mutated = true;
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
  // Bugbot M (PR #83): preserve the input array reference when nothing
  // actually changed. Otherwise `cohort` thrashed on every SSE event,
  // including non-HP events like RANK_CHANGED, breaking memoization.
  return mutated ? out : (tokens as TokenResponse[]);
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

/// Per-address sequence id for the "HP just updated" pulse — Epic 1.17c.
///
/// Returns a Map<lowercase-address, computedAt-seconds> for tokens whose
/// most-recent HP_UPDATED arrived within `recencyMs`. Consumers (the
/// leaderboard row's HP-bar wrapper) use the seq as a React `key` so the
/// CSS animation REPLAYS on each successive update — without the seq, a
/// second update within the recency window would leave the className
/// unchanged and the single-shot animation wouldn't re-trigger.
///
/// `nowMs` is injectable for tests.
export function freshHpUpdateSeqByAddress(
  hpByAddress: ReadonlyMap<string, HpUpdate>,
  recencyMs: number,
  nowMs: number = Date.now(),
): ReadonlyMap<string, number> {
  if (hpByAddress.size === 0) return EMPTY_SEQ_MAP;
  const cutoff = nowMs - recencyMs;
  const out = new Map<string, number>();
  for (const [addr, upd] of hpByAddress) {
    const t = Date.parse(upd.receivedAtIso);
    if (Number.isFinite(t) && t >= cutoff) out.set(addr, upd.computedAt);
  }
  return out.size === 0 ? EMPTY_SEQ_MAP : out;
}

const EMPTY_SEQ_MAP: ReadonlyMap<string, number> = new Map();
