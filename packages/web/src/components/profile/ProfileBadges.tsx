"use client";

/// Profile badges row — Epic 1.24 (spec §38).
///
/// Renders the badge list as colored pills with a tooltip explaining each.
/// **Critical**: ANNUAL_FINALIST + ANNUAL_CHAMPION are filtered at render
/// time as defense-in-depth. The indexer also strips them (see
/// `packages/indexer/src/api/profile.ts`), so under normal conditions this
/// filter is a no-op — but if a future indexer regression were to start
/// returning them, the web layer wouldn't render them either. Spec §33.8
/// (revisited 2026-05-04 with Epic 1.24).

import type {CSSProperties} from "react";

import {C} from "@/lib/tokens";

const ANNUAL_BADGES: ReadonlySet<string> = new Set(["ANNUAL_FINALIST", "ANNUAL_CHAMPION"]);

type BadgeMeta = {
  label: string;
  tooltip: string;
  color: string;
};

const BADGE_META: Record<string, BadgeMeta> = {
  WEEK_WINNER: {
    label: "Week Winner",
    tooltip: "Held the winning token at finalize",
    color: C.yellow,
  },
  FILTER_SURVIVOR: {
    label: "Filter Survivor",
    tooltip: "Held a token that survived the first cut",
    color: C.cyan,
  },
  CHAMPION_CREATOR: {
    label: "Champion Creator",
    tooltip: "Created a token that won its season",
    color: C.pink,
  },
  QUARTERLY_FINALIST: {
    label: "Quarterly Finalist",
    tooltip: "Held a token that reached the quarterly Filter Bowl finals",
    color: C.purple,
  },
  QUARTERLY_CHAMPION: {
    label: "Quarterly Champion",
    tooltip: "Held the token that won the quarterly Filter Bowl",
    color: C.purple,
  },
};

export function ProfileBadges({badges}: {badges: ReadonlyArray<string>}) {
  // Defense-in-depth strip of ANNUAL_*: spec §33.8.
  const visible = badges.filter((b) => !ANNUAL_BADGES.has(b) && b in BADGE_META);
  if (visible.length === 0) {
    return (
      <div style={{color: C.dim, fontSize: 13}}>
        No badges yet ▼
      </div>
    );
  }
  return (
    <div style={{display: "flex", flexWrap: "wrap", gap: 8}}>
      {visible.map((b) => {
        const meta = BADGE_META[b]!;
        return <BadgePill key={b} meta={meta} />;
      })}
    </div>
  );
}

function BadgePill({meta}: {meta: BadgeMeta}) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 999,
    background: `${meta.color}22`,
    border: `1px solid ${meta.color}66`,
    color: meta.color,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.02em",
    cursor: "help",
  };
  return (
    <span style={style} title={meta.tooltip}>
      {meta.label}
    </span>
  );
}
