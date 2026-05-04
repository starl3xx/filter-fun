"use client";

/// Arena view toggle (Epic 1.19 — spec §19.6.1).
///
/// Two-icon segmented control that switches the leaderboard between the
/// canonical row layout and the new tile grid. List stays the default; the
/// user's choice persists in `localStorage` under `arena_view_mode` so a
/// reload preserves it.
///
/// On mobile (<700px) the toggle hides and the home page force-renders the
/// list view — the tile grid's three-column layout doesn't fit a phone, and
/// a one-column degenerate tile is visually identical to the row layout
/// while costing more DOM nodes. The hidden state is driven by CSS only
/// (`@media (max-width: 700px)`) so SSR doesn't render-blind. The mobile
/// force-list lives upstream in `page.tsx` (effective view = stored mode +
/// matchMedia gate).
///
/// The toggle is intentionally an icon-pair, not labeled buttons — it sits
/// to the right of the existing sort/filter controls and the icons are
/// universally legible (4 horizontal lines for list, 2×2 grid for tile).
/// The active mode picks up the broadcast pink-glow treatment from PR #63.

import {useCallback, useEffect, useState} from "react";

import {C, F} from "@/lib/tokens";

export type ArenaViewMode = "list" | "tile";

export const ARENA_VIEW_MODE_KEY = "arena_view_mode";

export type ViewToggleProps = {
  value: ArenaViewMode;
  onChange: (mode: ArenaViewMode) => void;
  /// Aria-label for the segmented control wrapper. The dispatch caller
  /// provides one but a default keeps storybook-style standalone renders
  /// readable.
  ariaLabel?: string;
};

/// Read the persisted mode synchronously. Returns `"list"` (the default) on
/// SSR, on first visit, or when the stored value is unrecognised — defending
/// the consumer against arbitrary JSON the user might have set.
export function readStoredViewMode(): ArenaViewMode {
  if (typeof window === "undefined") return "list";
  try {
    const raw = window.localStorage.getItem(ARENA_VIEW_MODE_KEY);
    if (raw === "tile" || raw === "list") return raw;
  } catch {
    // Private mode / disabled storage — fall through to default.
  }
  return "list";
}

/// Persist the mode. No-op on SSR; swallow private-mode write failures —
/// the in-memory state already reflects the user's choice this session.
export function writeStoredViewMode(mode: ArenaViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ARENA_VIEW_MODE_KEY, mode);
  } catch {
    // Ignore.
  }
}

/// React hook — owns the persisted view mode. The setter writes through to
/// localStorage so consumers don't have to remember to. Defaults to "list"
/// on SSR; rehydrates from storage on mount.
export function useArenaViewMode(): [ArenaViewMode, (mode: ArenaViewMode) => void] {
  const [mode, setMode] = useState<ArenaViewMode>("list");
  useEffect(() => {
    setMode(readStoredViewMode());
  }, []);
  // **Stable setter identity** — bugbot Low (PR #91, commit 278b16d).
  // Without `useCallback` the setter is a fresh closure on every parent
  // render, which busts any `useMemo`/`useCallback` downstream that
  // captures it (e.g. memoized props passed into `<ViewToggle>`). The
  // dependency array is empty because `setMode` is a stable React setter
  // and `writeStoredViewMode` is a module-scope function.
  const set = useCallback((next: ArenaViewMode) => {
    setMode(next);
    writeStoredViewMode(next);
  }, []);
  return [mode, set];
}

export function ViewToggle({value, onChange, ariaLabel = "Leaderboard view mode"}: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="ff-arena-view-toggle"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: 99,
        background: "rgba(255,255,255,0.04)",
        border: `1px solid ${C.line}`,
      }}
    >
      <Button
        active={value === "list"}
        ariaLabel="List view"
        onClick={() => onChange("list")}
      >
        <ListIcon />
      </Button>
      <Button
        active={value === "tile"}
        ariaLabel="Tile view"
        onClick={() => onChange("tile")}
      >
        <TileIcon />
      </Button>
    </div>
  );
}

function Button({
  active,
  ariaLabel,
  onClick,
  children,
}: {
  active: boolean;
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      title={ariaLabel + (active ? " (current)" : "")}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 99,
        // Inactive button is fully transparent — the wrapper supplies the
        // segmented-control border. The pink-glow treatment ramps in only
        // on the active button so the eye latches onto the current mode.
        background: active ? `linear-gradient(135deg, ${C.pink}cc, ${C.purple}aa)` : "transparent",
        boxShadow: active ? `0 0 12px ${C.pink}66` : "none",
        border: "none",
        color: active ? "#fff" : C.dim,
        cursor: "pointer",
        font: "inherit",
        fontFamily: F.display,
        padding: 0,
        transition: "background 180ms ease, box-shadow 180ms ease, color 180ms ease",
      }}
    >
      {children}
    </button>
  );
}

function ListIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden focusable="false">
      <line x1={2} y1={3}  x2={12} y2={3}  stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={2} y1={6}  x2={12} y2={6}  stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={2} y1={9}  x2={12} y2={9}  stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={2} y1={12} x2={12} y2={12} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

function TileIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden focusable="false">
      <rect x={1.5}  y={1.5}  width={4.5} height={4.5} rx={1} stroke="currentColor" strokeWidth={1.4} fill="none" />
      <rect x={8}    y={1.5}  width={4.5} height={4.5} rx={1} stroke="currentColor" strokeWidth={1.4} fill="none" />
      <rect x={1.5}  y={8}    width={4.5} height={4.5} rx={1} stroke="currentColor" strokeWidth={1.4} fill="none" />
      <rect x={8}    y={8}    width={4.5} height={4.5} rx={1} stroke="currentColor" strokeWidth={1.4} fill="none" />
    </svg>
  );
}
