"use client";

/// Launch hero — the headline + summary card on the /launch page (spec §18.2).
///
///   ┌──────────────────────────────────────────────┐ ┌─────────────────┐
///   │ ● WEEK 02 · LAUNCH WINDOW OPEN               │ │ 🏆 CHAMPION     │
///   │ Launch into the filter ▼                     │ │ Ξ14.82          │
///   │ 12 tokens enter each week. Most get filtered.│ │ Winner absorbs  │
///   │ One gets funded.                             │ │ all filtered    │
///   │ [Launch Token →] [View Current Launches]     │ │ liquidity.      │
///   │ slots · window · next cost                   │ │ ─ Backing 6.42 ─│
///   └──────────────────────────────────────────────┘ └─────────────────┘
///
/// The slot-fill bar across the bottom is the visual anchor — 12 segments
/// matching the slot grid below, animated as new launches land.

import {useEffect, useState} from "react";

import type {SeasonResponse} from "@/lib/arena/api";
import {fmtCutCountdown, fmtEth, weekLabel} from "@/lib/arena/format";
import {C, F} from "@/lib/tokens";

import type {LaunchSlot} from "@/hooks/launch/useLaunchSlots";
import {Triangle} from "./Triangle";
import {fmtEthFromWei} from "@/lib/launch/format";

export type LaunchHeroProps = {
  season: SeasonResponse | null;
  slots: LaunchSlot[];
  status: {
    launchCount: number;
    maxLaunches: number;
    timeRemainingSec: number;
    nextLaunchCostWei: bigint;
  } | null;
  onScrollToForm: () => void;
};

export function LaunchHero({season, slots, status, onScrollToForm}: LaunchHeroProps) {
  const launchCount = status?.launchCount ?? 0;
  const maxLaunches = status?.maxLaunches ?? 12;
  const open = launchCount < maxLaunches && (status?.timeRemainingSec ?? 0) > 0;
  const week = weekLabel(season?.seasonId ?? 0);

  return (
    <section
      aria-label="Launch hero"
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 360px)",
        gap: 16,
        padding: 22,
        borderRadius: 18,
        background:
          "radial-gradient(80% 90% at 0% 0%, rgba(255,58,161,0.12), transparent 60%), radial-gradient(60% 80% at 100% 100%, rgba(156,92,255,0.18), transparent 70%), rgba(20,8,40,0.55)",
        border: `1px solid ${C.line}`,
        overflow: "hidden",
      }}
      className="ff-launch-hero"
    >
      <div style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
        <PhaseBadge week={week} open={open} />
        <h1
          style={{
            margin: 0,
            fontFamily: F.display,
            fontWeight: 900,
            fontSize: "clamp(36px, 6vw, 64px)",
            letterSpacing: "-0.02em",
            lineHeight: 1.02,
            color: C.text,
          }}
        >
          Launch into the{" "}
          <span
            style={{
              background: "linear-gradient(90deg, #ff5fb8, #ff2d55, #ffe933)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            filter
          </span>{" "}
          <Triangle size={48} inline />
        </h1>
        <p style={{margin: 0, fontSize: 16, color: C.dim, maxWidth: 640}}>
          12 tokens enter each week. Most get filtered.{" "}
          <span style={{color: C.yellow, fontWeight: 700}}>One gets funded.</span>
        </p>
        <p style={{margin: 0, fontSize: 13, color: C.red, fontFamily: F.mono, fontWeight: 600}}>
          Most tokens die here. You're competing for survival.
        </p>

        <div style={{display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4}}>
          <button
            type="button"
            onClick={onScrollToForm}
            disabled={!open}
            style={{
              background: open ? "linear-gradient(135deg, #ff3aa1, #9c5cff)" : "rgba(255,255,255,0.06)",
              color: open ? "#fff" : C.faint,
              border: "none",
              padding: "12px 20px",
              borderRadius: 10,
              fontWeight: 800,
              fontSize: 14,
              cursor: open ? "pointer" : "not-allowed",
              boxShadow: open ? "0 8px 24px rgba(255, 58, 161, 0.45)" : "none",
            }}
          >
            Launch Token →
          </button>
          <a
            href="/"
            style={{
              background: "transparent",
              color: C.text,
              border: `1px solid ${C.line}`,
              padding: "12px 20px",
              borderRadius: 10,
              fontWeight: 700,
              fontSize: 14,
              textDecoration: "none",
            }}
          >
            View Current Launches
          </a>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
            marginTop: 10,
          }}
        >
          <SummaryStat label="Slots filled" value={`${launchCount}/${maxLaunches}`} foot={`${maxLaunches - launchCount} open`} />
          <SummaryStat
            label="Window closes"
            value={status ? fmtCutCountdown(status.timeRemainingSec) : "—"}
            foot="48h cycle"
          />
          <SummaryStat
            label="Next cost"
            value={status ? fmtEthFromWei(status.nextLaunchCostWei) : "Ξ —"}
            foot="rises per slot"
          />
        </div>

        <SlotFillBar slots={slots} />
      </div>

      <ChampionPanel season={season} />
    </section>
  );
}

function PhaseBadge({week, open}: {week: string; open: boolean}) {
  const color = open ? C.pink : C.faint;
  return (
    <div
      style={{
        alignSelf: "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 99,
        border: `1px solid ${color}55`,
        background: `${color}1a`,
        color,
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: 10,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      <span
        className={open ? "ff-pulse" : undefined}
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: color,
          boxShadow: open ? `0 0 8px ${color}` : "none",
        }}
      />
      {week} · {open ? "Launch window open" : "Launch window closed"}
    </div>
  );
}

function SummaryStat({label, value, foot}: {label: string; value: string; foot: string}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: F.mono,
          color: C.cyan,
          letterSpacing: "0.16em",
          fontWeight: 700,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: 22,
          color: C.text,
          fontVariantNumeric: "tabular-nums",
          marginTop: 2,
        }}
      >
        {value}
      </div>
      <div style={{fontSize: 10, color: C.dim, marginTop: 2}}>{foot}</div>
    </div>
  );
}

function SlotFillBar({slots}: {slots: LaunchSlot[]}) {
  return (
    <div style={{marginTop: 6}}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 9,
          fontFamily: F.mono,
          color: C.faint,
          letterSpacing: "0.16em",
          fontWeight: 700,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        <span>Slot fill</span>
        <span>
          {slots.filter((s) => s.kind === "filled" || s.kind === "filled-pending").length} / {slots.length} ·{" "}
          {slots.filter((s) => s.kind === "next" || s.kind === "almost" || s.kind === "open").length} open
        </span>
      </div>
      <div
        role="img"
        aria-label="Slot fill"
        style={{display: "grid", gridTemplateColumns: `repeat(${slots.length}, 1fr)`, gap: 4}}
      >
        {slots.map((slot) => (
          <div
            key={slot.slotIndex}
            style={{
              height: 8,
              borderRadius: 99,
              background:
                slot.kind === "filled" || slot.kind === "filled-pending"
                  ? "linear-gradient(90deg, #ff3aa1, #9c5cff)"
                  : "rgba(255,255,255,0.08)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ChampionPanel({season}: {season: SeasonResponse | null}) {
  // Subtle "still rising" pill — true while we're in launch / competition
  // (the pool only stops growing in finals once finalists are locked in).
  const growing = season ? season.phase === "launch" || season.phase === "competition" : false;
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    setPulse(growing);
  }, [growing]);
  return (
    <aside
      aria-label="Champion pool"
      style={{
        padding: 16,
        borderRadius: 14,
        border: `1px solid ${C.yellow}55`,
        background: "rgba(255, 233, 51, 0.04)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <span style={{display: "flex", alignItems: "center", gap: 6}}>
          <span aria-hidden style={{fontSize: 14}}>🏆</span>
          <span
            style={{
              fontFamily: F.mono,
              fontWeight: 800,
              fontSize: 10,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: C.yellow,
            }}
          >
            Champion Pool
          </span>
          <Triangle size={10} inline />
        </span>
        <span
          className={pulse ? "ff-pulse" : undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 99,
            border: `1px solid ${C.green}55`,
            background: `${C.green}1a`,
            color: C.green,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 9,
            letterSpacing: "0.16em",
          }}
        >
          {pulse ? "● GROWING" : "● PAUSED"}
        </span>
      </div>
      <div
        style={{
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: 44,
          color: C.yellow,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
        }}
      >
        {fmtEth(season?.championPool ?? "0")}
      </div>
      <p style={{margin: 0, fontSize: 12, color: C.dim, lineHeight: 1.45}}>
        Winner absorbs <span style={{color: C.text, fontWeight: 700}}>all filtered liquidity</span>. One token walks
        away with the pool.
      </p>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          borderRadius: 10,
          border: `1px solid ${C.cyan}33`,
          background: "rgba(0, 240, 255, 0.04)",
        }}
      >
        <div style={{display: "flex", flexDirection: "column"}}>
          <span style={{fontSize: 9, fontFamily: F.mono, color: C.cyan, letterSpacing: "0.14em", fontWeight: 700, textTransform: "uppercase"}}>
            Champion Backing Pool
          </span>
          <span style={{fontSize: 10, color: C.dim}}>Protocol-owned liquidity for the winner</span>
        </div>
        <div
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 18,
            color: C.cyan,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtEth(season?.polReserve ?? "0")}
        </div>
      </div>
    </aside>
  );
}

