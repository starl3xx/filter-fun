"use client";

/// FloatingHpDelta — tile-view "damage number" overlay (Epic 1.19).
///
/// When an HP_UPDATED SSE frame arrives for a token, the tile shows a
/// short-lived `+12` (green) or `−34` (red) anchored to its HP integer.
/// Conveys direction + magnitude in a single glance (versus a uniform
/// pulse). Inspired by the damage-number convention from action games —
/// an apt cultural metaphor since HP is rendered as a hit-points integer.
///
/// Animation: rises ~30px upward + fades opacity 1 → 0 over ~2s. Single-
/// shot; the consumer mounts a fresh element per update by keying on the
/// HP_UPDATED `computedAt` seq, so successive deltas don't queue or
/// stack. The tile owner unmounts the element after the timer fires
/// (cleaner DOM than leaving stale 0-opacity nodes).

import {useEffect, useState} from "react";

import {C, F} from "@/lib/tokens";

export type FloatingHpDeltaProps = {
  /// Signed delta — positive for HP gains, negative for losses. The sign
  /// drives both the colour and the leading glyph; magnitude is rendered
  /// with a thousands separator when ≥ 1000 so a four-digit swing is still
  /// scannable at a glance.
  delta: number;
  /// Lifetime in ms. Tests inject a very short value so the cleanup branch
  /// is exercisable without `vi.advanceTimersByTime`. Production callers
  /// leave the default ~2000ms.
  durationMs?: number;
  /// Fired after the lifetime expires. The tile uses this to unmount the
  /// element so stale 0-opacity nodes don't accumulate.
  onComplete?: () => void;
};

export function FloatingHpDelta({delta, durationMs = 2000, onComplete}: FloatingHpDeltaProps) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDone(true);
      onComplete?.();
    }, durationMs);
    return () => clearTimeout(t);
  }, [durationMs, onComplete]);

  if (done) return null;
  if (delta === 0) return null;

  const positive = delta > 0;
  const magnitude = Math.abs(delta).toLocaleString("en-US");
  // Use the U+2212 MINUS SIGN (not the ASCII hyphen U+002D) so the negative
  // glyph visually matches the rest of the broadcast typography — Bricolage
  // ships a wider minus that pairs better with tabular-nums than the bare
  // hyphen.
  const sign = positive ? "+" : "−";
  const color = positive ? C.green : C.red;

  return (
    <span
      data-floating-hp-delta="true"
      data-delta-sign={positive ? "positive" : "negative"}
      aria-hidden
      className="ff-arena-tile-hp-delta"
      style={{
        position: "absolute",
        top: -2,
        right: -4,
        // The dispatch describes the delta as anchored to the HP integer —
        // tile owner positions this absolutely inside a relative HP block
        // wrapper so coordinates stay tile-local.
        pointerEvents: "none",
        fontFamily: F.display,
        fontWeight: 800,
        fontSize: 14,
        color,
        textShadow: `0 0 8px ${color}99`,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        // The animation itself lives in globals.css (`ff-arena-tile-hp-delta`)
        // — translate-up + fade. Defining it CSS-side keeps the component
        // amenable to `prefers-reduced-motion` overrides without a JS branch.
        animationDuration: `${durationMs}ms`,
      }}
    >
      {sign}
      {magnitude}
    </span>
  );
}
