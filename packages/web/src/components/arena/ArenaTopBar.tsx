"use client";

/// Arena top bar (spec §19.4).
///
///   LIVE — Week 02      Next cut in: 04:12:33      Champion Pool: Ξ14.82      Champion Backing Pool: Ξ6.42 ↑
///
/// - LIVE indicator pulses green when SSE is connected, dims when reconnecting.
/// - Countdown ticks locally every second; resyncs to `season.nextCutAt`
///   once per minute (countdownIso changes when the server publishes a new
///   anchor).
/// - Champion Backing Pool gets a brief subtle glow when its value grows
///   between polls — implemented by tracking the previous value in a ref and
///   re-applying a CSS class for ~2s on increase.

import {useEffect, useRef, useState} from "react";

import {Triangle} from "@/components/Triangle";
import {fmtCutCountdown, fmtEth, secondsUntil, weekLabel} from "@/lib/arena/format";
import type {SeasonResponse} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

export type ArenaTopBarProps = {
  season: SeasonResponse | null;
  /// SSE status from useTickerEvents — controls the LIVE indicator color.
  liveStatus: "connecting" | "open" | "reconnecting" | "closed";
};

export function ArenaTopBar({season, liveStatus}: ArenaTopBarProps) {
  const countdownSec = useTickingCountdown(season?.nextCutAt ?? null);
  // Pass `null` until season loads so the loading-sentinel "0" doesn't get
  // mistaken for a previous value the first real response then "grows" past.
  const backingGlow = useGrowthGlow(season?.polReserve ?? null);

  const liveColor = liveStatus === "open" ? C.green : liveStatus === "closed" ? C.faint : C.yellow;
  const liveText = liveStatus === "open" ? "LIVE" : liveStatus === "reconnecting" ? "RECONNECTING" : liveStatus === "closed" ? "OFFLINE" : "CONNECTING";

  return (
    <header
      className="ff-arena-topbar"
      role="banner"
      aria-label="Arena status"
      style={{
        position: "relative",
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 18px",
        borderBottom: `1px solid ${C.line}`,
        background: "rgba(20,8,40,0.55)",
        backdropFilter: "blur(8px)",
        flexWrap: "wrap",
      }}
    >
      <div style={{display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap"}}>
        <Brand />
        <Pill color={liveColor}>
          <Dot color={liveColor} pulse={liveStatus === "open"} />
          {liveText}
        </Pill>
        <span style={{fontSize: 11, fontFamily: F.mono, color: C.dim, letterSpacing: "0.18em", fontWeight: 800}}>
          {weekLabel(season?.seasonId ?? 0)}
        </span>
      </div>

      <div style={{display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap"}}>
        <Stat label="Next cut in" value={countdownSec === null ? "—" : fmtCutCountdown(countdownSec)} mono />
        <Stat label="Champion Pool" value={fmtEth(season?.championPool ?? "0")} accent={C.yellow} title="Spec §19.5: Winner takes everything." />
        <Stat
          label="Champion Backing"
          value={fmtEth(season?.polReserve ?? "0")}
          accent={C.cyan}
          glow={backingGlow}
          title="Spec §19.5: Protocol backing for the winner."
        />
      </div>
    </header>
  );
}

function Brand() {
  // ARENA_SPEC §6.1 — wordmark renders `filter` in white + `.fun` in pink.
  // Audit H-Arena-6 caught the pre-fix all-white render which lost the brand
  // colour signal at the most prominent surface in the app.
  return (
    <span style={{display: "flex", alignItems: "center", gap: 6}}>
      <span aria-hidden style={{display: "inline-flex", filter: `drop-shadow(0 0 6px ${C.red}88)`}}>
        <Triangle size={18} />
      </span>
      <span style={{fontFamily: F.display, fontWeight: 800, fontSize: 16, letterSpacing: "-0.01em"}}>
        <span style={{color: C.text}}>filter</span>
        <span style={{color: C.pink}}>.fun</span>
      </span>
    </span>
  );
}

/// ARENA_SPEC §6.1 — LIVE-pill style: padding 5×11, bg @ 12% alpha (`1f`),
/// border @ 40% alpha (`66`). Audit H-Arena-5 caught the pre-fix `3×10 / 1a /
/// 55` (10% bg, ~33% border) which made the pill read as a faint chip rather
/// than the assertive LIVE marker the spec calls for.
function Pill({color, children}: {color: string; children: React.ReactNode}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 11px",
        borderRadius: 99,
        background: `${color}1f`,
        border: `1px solid ${color}66`,
        color,
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: 9,
        letterSpacing: "0.16em",
      }}
    >
      {children}
    </span>
  );
}

function Dot({color, pulse}: {color: string; pulse: boolean}) {
  return (
    <span
      className={pulse ? "ff-pulse" : undefined}
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 99,
        background: color,
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
      }}
    />
  );
}

function Stat({
  label,
  value,
  mono,
  accent,
  glow,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: string;
  glow?: boolean;
  title?: string;
}) {
  return (
    <div title={title} style={{display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.1}}>
      <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.16em", fontWeight: 700, textTransform: "uppercase"}}>
        {label}
      </span>
      <span
        className={glow ? "ff-arena-glow" : undefined}
        style={{
          fontSize: 16,
          fontWeight: 800,
          fontFamily: mono ? F.mono : F.display,
          color: accent ?? C.text,
          fontVariantNumeric: "tabular-nums",
          textShadow: glow ? `0 0 14px ${accent ?? C.cyan}` : "none",
          transition: "text-shadow 0.6s ease",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/// Local 1Hz countdown — resyncs whenever the server's nextCutAt changes.
/// Returns `null` when there's no anchor (settled phase / pre-season).
function useTickingCountdown(iso: string | null): number | null {
  const [secs, setSecs] = useState<number | null>(() => (iso ? secondsUntil(iso) : null));
  useEffect(() => {
    if (!iso) {
      setSecs(null);
      return;
    }
    setSecs(secondsUntil(iso));
    const id = setInterval(() => setSecs(secondsUntil(iso)), 1000);
    return () => clearInterval(id);
  }, [iso]);
  return secs;
}

/// Returns true for ~2s after `value` increases between renders. Drives the
/// "Champion Backing Pool ↑" glow without needing an explicit event.
///
/// The reset is anchored to a "glow-until" timestamp rather than a bare
/// `setTimeout(setGlow(false))` because the previous timer-based approach
/// could leave glow stuck on: a non-increase value change cancelled the
/// pending timer (via effect cleanup) but the new effect run took the
/// else branch and never cleared `glow`. Anchoring on a ref + setting a
/// trailing timer that *checks the ref* keeps the truth in one place.
///
/// Pass `null` while the upstream value is still loading. The hook treats
/// the first `null → real` transition as "initial load, not growth" — so
/// the Champion Backing Pool doesn't flash on every page mount.
function useGrowthGlow(value: string | null): boolean {
  const prev = useRef<string | null>(null);
  const glowUntilRef = useRef<number>(0);
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    // Skip while loading — record nothing, signal nothing. Once the first
    // real value arrives, prev becomes that value and only *subsequent*
    // changes are scored as growth.
    if (value === null) return;
    const prevNum = prev.current === null ? null : Number(prev.current);
    const curNum = Number(value);
    const isGrowth =
      prev.current !== null &&
      Number.isFinite(prevNum) &&
      Number.isFinite(curNum) &&
      curNum > (prevNum ?? 0);
    prev.current = value;
    if (isGrowth) {
      glowUntilRef.current = Date.now() + 2_000;
      setGlow(true);
      const id = setTimeout(() => {
        // Only clear if no later growth has extended the window.
        if (Date.now() >= glowUntilRef.current) setGlow(false);
      }, 2_000);
      return () => clearTimeout(id);
    }
    // Non-growth value change: ensure glow is off (cleanup of a prior run
    // may have cancelled its trailing timer before it fired).
    if (Date.now() >= glowUntilRef.current) setGlow(false);
  }, [value]);
  return glow;
}
