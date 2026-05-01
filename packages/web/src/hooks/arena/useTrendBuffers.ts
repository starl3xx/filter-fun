"use client";

import {useEffect, useRef, useState} from "react";

import type {TokenResponse} from "@/lib/arena/api";

/// Maintains a rolling per-token buffer of recent HP samples — the sparkline
/// data the leaderboard renders. Built incrementally from each `/tokens`
/// poll, since the indexer doesn't yet expose HP history (price history
/// will land alongside trade indexing).
///
/// Buffer is capped at `maxSamples`. Old token addresses are dropped from
/// the map when they fall out of the cohort, so a long-running session
/// doesn't accumulate state for filtered tokens.

export type TrendMap = Map<`0x${string}`, number[]>;

export function useTrendBuffers(tokens: TokenResponse[] | null, maxSamples: number = 24): TrendMap {
  const bufferRef = useRef<TrendMap>(new Map());
  const [snapshot, setSnapshot] = useState<TrendMap>(new Map());

  useEffect(() => {
    if (!tokens) return;
    const next = new Map(bufferRef.current);
    const seen = new Set<`0x${string}`>();
    for (const t of tokens) {
      seen.add(t.token);
      const prev = next.get(t.token) ?? [];
      const merged = [...prev, t.hp];
      next.set(t.token, merged.length > maxSamples ? merged.slice(merged.length - maxSamples) : merged);
    }
    // Drop tokens no longer in the cohort.
    for (const k of next.keys()) if (!seen.has(k)) next.delete(k);
    bufferRef.current = next;
    setSnapshot(next);
  }, [tokens, maxSamples]);

  return snapshot;
}
