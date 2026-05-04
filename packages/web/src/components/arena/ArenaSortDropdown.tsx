"use client";

/// Arena tile-view sort dropdown (Epic 1.19 — spec §19.6.1).
///
/// Tile-only — the row view's canonical sort is rank-ascending and isn't
/// user-configurable. Four options are spec-locked:
///
///   - hp-desc       (default; matches list view)
///   - status        (FINALIST → SAFE → AT_RISK → FILTERED)
///   - activity      (most-recent HP update first)
///   - delta         (largest absolute HP move first)
///
/// Choice persists in localStorage as `arena_sort`. Filtered tokens always
/// sort to the bottom regardless of the chosen mode (spec §19.6.1) — the
/// dropdown selects the order *among non-filtered tokens*; filtered are
/// appended after.

import {useEffect, useMemo, useState} from "react";

import type {TokenResponse} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

export type ArenaSortMode = "hp-desc" | "status" | "activity" | "delta";

export const ARENA_SORT_KEY = "arena_sort";

export const ARENA_SORT_OPTIONS: ReadonlyArray<{mode: ArenaSortMode; label: string}> = [
  {mode: "hp-desc",  label: "HP descending"},
  {mode: "status",   label: "By status"},
  {mode: "activity", label: "By recent activity"},
  {mode: "delta",    label: "By recent HP delta"},
];

const DEFAULT_MODE: ArenaSortMode = "hp-desc";

/// Read the persisted sort mode synchronously. Returns the default on SSR,
/// first visit, or any unrecognised stored string.
export function readStoredSortMode(): ArenaSortMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(ARENA_SORT_KEY);
    if (raw && ARENA_SORT_OPTIONS.some((o) => o.mode === raw)) {
      return raw as ArenaSortMode;
    }
  } catch {
    // Private mode — fall through.
  }
  return DEFAULT_MODE;
}

export function writeStoredSortMode(mode: ArenaSortMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ARENA_SORT_KEY, mode);
  } catch {
    // Ignore.
  }
}

/// React hook owning the persisted sort. Defaults to "hp-desc" on SSR;
/// rehydrates from storage on mount. Setter persists through to storage.
export function useArenaSortMode(): [ArenaSortMode, (m: ArenaSortMode) => void] {
  const [mode, setMode] = useState<ArenaSortMode>(DEFAULT_MODE);
  useEffect(() => {
    setMode(readStoredSortMode());
  }, []);
  const set = (next: ArenaSortMode) => {
    setMode(next);
    writeStoredSortMode(next);
  };
  return [mode, set];
}

export type ArenaSortDropdownProps = {
  value: ArenaSortMode;
  onChange: (mode: ArenaSortMode) => void;
};

export function ArenaSortDropdown({value, onChange}: ArenaSortDropdownProps) {
  return (
    <label
      className="ff-arena-sort-dropdown"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10,
        fontFamily: F.mono,
        color: C.dim,
        letterSpacing: "0.12em",
        fontWeight: 700,
        textTransform: "uppercase",
      }}
    >
      <span aria-hidden>Sort</span>
      <select
        aria-label="Sort tile view"
        value={value}
        onChange={(e) => onChange(e.target.value as ArenaSortMode)}
        style={{
          background: "rgba(255,255,255,0.04)",
          border: `1px solid ${C.line}`,
          borderRadius: 6,
          color: C.text,
          fontFamily: F.mono,
          fontSize: 11,
          fontWeight: 700,
          padding: "4px 8px",
          letterSpacing: "0.04em",
          textTransform: "none",
          cursor: "pointer",
        }}
      >
        {ARENA_SORT_OPTIONS.map((o) => (
          <option key={o.mode} value={o.mode}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/// Sort the cohort by the chosen mode. Filtered tokens always sort to the
/// bottom regardless of the mode (spec §19.6.1) — the mode picks the order
/// of the remaining tokens, then filtered are appended.
///
/// `hpUpdateMeta` is an optional Map<lowercase-address, {computedAt, prevHp}>
/// providing live activity / delta context for the "activity" / "delta"
/// modes. Without it, those modes degrade gracefully to rank order so the
/// dropdown remains usable in tests / pre-data states.
export function sortTokensForTile(
  tokens: ReadonlyArray<TokenResponse>,
  mode: ArenaSortMode,
  hpUpdateMeta?: ReadonlyMap<string, {computedAt: number; prevHp: number}>,
): TokenResponse[] {
  const filtered: TokenResponse[] = [];
  const surviving: TokenResponse[] = [];
  for (const t of tokens) {
    (t.status === "FILTERED" ? filtered : surviving).push(t);
  }
  surviving.sort(comparatorFor(mode, hpUpdateMeta));
  // Filtered tokens are still ordered amongst themselves by HP-desc so a
  // chunk of identical "FILTERED" rows isn't re-shuffled on every render.
  filtered.sort((a, b) => b.hp - a.hp);
  return [...surviving, ...filtered];
}

function comparatorFor(
  mode: ArenaSortMode,
  meta?: ReadonlyMap<string, {computedAt: number; prevHp: number}>,
): (a: TokenResponse, b: TokenResponse) => number {
  switch (mode) {
    case "hp-desc":
      return (a, b) => b.hp - a.hp || compareRank(a, b);
    case "status":
      return (a, b) => {
        const da = STATUS_RANK[a.status];
        const db = STATUS_RANK[b.status];
        if (da !== db) return da - db;
        return b.hp - a.hp;
      };
    case "activity": {
      if (!meta || meta.size === 0) return (a, b) => compareRank(a, b);
      return (a, b) => {
        const ma = meta.get(a.token.toLowerCase())?.computedAt ?? 0;
        const mb = meta.get(b.token.toLowerCase())?.computedAt ?? 0;
        if (ma !== mb) return mb - ma;
        return compareRank(a, b);
      };
    }
    case "delta": {
      if (!meta || meta.size === 0) return (a, b) => compareRank(a, b);
      return (a, b) => {
        const da = Math.abs(a.hp - (meta.get(a.token.toLowerCase())?.prevHp ?? a.hp));
        const db = Math.abs(b.hp - (meta.get(b.token.toLowerCase())?.prevHp ?? b.hp));
        if (da !== db) return db - da;
        return compareRank(a, b);
      };
    }
  }
}

const STATUS_RANK: Record<TokenResponse["status"], number> = {
  FINALIST: 0,
  SAFE: 1,
  AT_RISK: 2,
  FILTERED: 3, // Filtered are pulled out of the comparator anyway; rank is unused.
};

function compareRank(a: TokenResponse, b: TokenResponse): number {
  if (a.rank === 0 && b.rank === 0) return a.token.localeCompare(b.token);
  if (a.rank === 0) return 1;
  if (b.rank === 0) return -1;
  return a.rank - b.rank;
}

/// Convenience hook: wraps `sortTokensForTile` in a `useMemo` so consumers
/// don't re-sort on every render when only unrelated state changes.
///
/// **`enabled` short-circuit** — bugbot finding (PR #91, commit 10c2dd2):
/// when the home page is in list mode (or mobile force-list, or filter-
/// moment firing/recap), the tile grid isn't rendered and the sort is
/// pure waste. Pass `enabled: false` from the page to skip the sort
/// (returns the input array unchanged). Rules of Hooks prevent us from
/// CALLING the hook conditionally, so the gate lives inside the memo.
export function useSortedTileTokens(
  tokens: ReadonlyArray<TokenResponse>,
  mode: ArenaSortMode,
  hpUpdateMeta?: ReadonlyMap<string, {computedAt: number; prevHp: number}>,
  enabled: boolean = true,
): TokenResponse[] {
  return useMemo(
    () => (enabled ? sortTokensForTile(tokens, mode, hpUpdateMeta) : (tokens as TokenResponse[])),
    [tokens, mode, hpUpdateMeta, enabled],
  );
}
