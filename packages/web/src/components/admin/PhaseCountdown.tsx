"use client";

import {useEffect, useState} from "react";

import type {SeasonResponse} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// Phase + countdown to next anchor, wired off the season's `nextCutAt` /
/// `finalSettlementAt` ISO timestamps. The cadence is locked at hour 96 (cut)
/// and hour 168 (settlement) per Epic 1.10 / spec §3.2 — those numbers come
/// from the indexer; we just render whatever the indexer says.

export function PhaseCountdown({season}: {season: SeasonResponse | null}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!season) {
    return (
      <Card label="Phase">
        <p style={{margin: 0, color: C.faint, fontFamily: F.mono, fontSize: 12}}>Loading…</p>
      </Card>
    );
  }

  const target = season.phase === "finals" ? season.finalSettlementAt : season.nextCutAt;
  const targetMs = new Date(target).getTime();
  const remainingMs = Math.max(0, targetMs - now);
  const phaseLabel = phaseCopy(season.phase);
  const anchorLabel = anchorCopy(season.phase);

  return (
    <Card label="Phase">
      <div style={{display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6}}>
        <span style={{fontSize: 16, fontWeight: 800, fontFamily: F.display, color: C.text}}>
          {phaseLabel}
        </span>
        <span style={{fontSize: 11, color: C.faint, fontFamily: F.mono, letterSpacing: "0.1em"}}>
          {anchorLabel}
        </span>
      </div>
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 24,
          fontWeight: 800,
          color: remainingMs < 5 * 60_000 ? C.red : C.text,
          letterSpacing: "0.04em",
        }}
      >
        {fmtCountdown(remainingMs)}
      </div>
    </Card>
  );
}

function phaseCopy(phase: SeasonResponse["phase"]): string {
  switch (phase) {
    case "launch":
      return "Launch window";
    case "competition":
      return "Trading";
    case "finals":
      return "Finals";
    case "settled":
      return "Settled";
  }
}

function anchorCopy(phase: SeasonResponse["phase"]): string {
  switch (phase) {
    case "launch":
      return "TO HARD CUT (HR 96)";
    case "competition":
      return "TO HARD CUT (HR 96)";
    case "finals":
      return "TO SETTLEMENT (HR 168)";
    case "settled":
      return "SEASON CLOSED";
  }
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(mins)}m`;
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
