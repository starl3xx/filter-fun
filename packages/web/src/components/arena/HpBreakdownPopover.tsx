"use client";

/// HP breakdown popover — Epic 1.28 list-view enhancement.
///
/// Spec §19.6.1 calls out a per-component HP breakdown on every leaderboard
/// surface. The tile view (PR #91) and the right-rail token detail panel
/// already render the canonical 5-component spec §6.6 set; the list view
/// previously surfaced only the bare HP bar. This popover closes that gap
/// by overlaying the breakdown on hover/focus over the HP cell.
///
/// **Accessibility & motion.**
///   - 200ms open delay so a quick mouse fly-by doesn't trigger the popover
///     (avoids hover-spam on dense leaderboards).
///   - Instant close on mouse-leave / blur — a stale popover after the
///     pointer moves on is more disorienting than a fast dismiss.
///   - `Escape` dismisses an open popover (delegated by the parent <Row>).
///   - Keyboard-accessible: the parent HP cell is `tabIndex={0}` and the
///     popover renders inside a `focus-within` group.
///   - `prefers-reduced-motion` collapses the open delay to 0 and skips
///     the transform transition (still uses opacity for the show/hide).

import {useEffect, useState} from "react";

import type {HpUpdate} from "@/hooks/arena/useHpUpdates";
import type {TokenResponse} from "@/lib/arena/api";
import {HP_MAX} from "@/lib/arena/hp";
import {HP_LABELS, HP_TILE_COMPONENT_COLORS, HP_TILE_KEYS_IN_ORDER, scoreToPct, type HpTileKey} from "@/lib/arena/hpLabels";
import {C, F} from "@/lib/tokens";

const POPOVER_DELAY_MS = 200;

export type HpBreakdownPopoverProps = {
  token: TokenResponse;
  /// Live HP overlay (Epic 1.17c). Polled `/tokens` carries 5 components
  /// (no `holderConcentration`); the SSE frame carries all 6 — read
  /// `holderConcentration` from `liveHp` when present so the canonical
  /// 5-component spec §6.6 set renders.
  liveHp: HpUpdate | null | undefined;
  /// Whether the parent row is currently hovered or focused. The popover
  /// fades in after `POPOVER_DELAY_MS` once `active` flips true; flips
  /// back to false instantly hides it.
  active: boolean;
};

export function HpBreakdownPopover({token, liveHp, active}: HpBreakdownPopoverProps) {
  const [shown, setShown] = useState(false);
  // `prefers-reduced-motion: reduce` collapses the open delay to 0.
  const reducedMotion = useReducedMotion();
  const delayMs = reducedMotion ? 0 : POPOVER_DELAY_MS;

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    if (delayMs === 0) {
      setShown(true);
      return;
    }
    const t = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(t);
  }, [active, delayMs]);

  const holderConcentration = liveHp?.components.holderConcentration ?? 0;
  const componentValues: Record<HpTileKey, number> = {
    velocity: token.components.velocity,
    effectiveBuyers: token.components.effectiveBuyers,
    stickyLiquidity: token.components.stickyLiquidity,
    retention: token.components.retention,
    holderConcentration,
  };

  return (
    <div
      role="tooltip"
      data-testid="hp-breakdown-popover"
      data-hp-popover-shown={shown ? "true" : "false"}
      aria-hidden={!shown}
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        left: 0,
        zIndex: 30,
        width: 240,
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${C.line}`,
        background: "rgba(20, 8, 40, 0.96)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        boxShadow: "0 16px 40px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
        opacity: shown ? 1 : 0,
        transform: shown || reducedMotion ? "translateY(0)" : "translateY(-4px)",
        pointerEvents: shown ? "auto" : "none",
        transition: reducedMotion ? "opacity 0.08s linear" : "opacity 0.12s ease, transform 0.12s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: F.mono,
          fontSize: 9,
          letterSpacing: "0.16em",
          color: C.dim,
          textTransform: "uppercase",
          fontWeight: 800,
          marginBottom: 8,
        }}
      >
        <span>HP Breakdown</span>
        <span style={{fontFamily: F.mono, fontWeight: 800, fontSize: 11, color: C.text, letterSpacing: 0, fontVariantNumeric: "tabular-nums"}}>
          {token.hp.toLocaleString()} / {HP_MAX.toLocaleString()}
        </span>
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: 6}}>
        {HP_TILE_KEYS_IN_ORDER.map((key) => (
          <ComponentRow
            key={key}
            label={HP_LABELS[key]}
            score={componentValues[key]}
            color={HP_TILE_COMPONENT_COLORS[key]}
          />
        ))}
      </div>
    </div>
  );
}

function ComponentRow({label, score, color}: {label: string; score: number; color: string}) {
  const pct = scoreToPct(score);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "70px 1fr 32px",
        alignItems: "center",
        gap: 8,
        fontSize: 11,
      }}
    >
      <span style={{color, fontFamily: F.display, fontWeight: 600, fontSize: 11}}>{label}</span>
      <span
        style={{
          display: "block",
          height: 4,
          borderRadius: 99,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${pct}%`,
            borderRadius: 99,
            background: `linear-gradient(90deg, ${color}, ${color}cc)`,
          }}
        />
      </span>
      <span
        style={{
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: 11,
          textAlign: "right",
          color: C.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {pct}
      </span>
    </div>
  );
}

/// Reads the user's `prefers-reduced-motion` setting and returns true when
/// the user prefers reduced motion. SSR-safe (returns false until mount).
/// Listens for changes so a system-level toggle takes effect without a
/// page reload.
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
