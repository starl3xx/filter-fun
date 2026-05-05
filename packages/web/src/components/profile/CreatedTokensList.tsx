"use client";

/// Created-tokens list on the profile page — Epic 1.24 (spec §38). One row
/// per token created by the wallet. Status maps onto a colored chip; rows
/// link to the token's detail page (`/token/<address>/admin` is the only
/// per-token surface today).
///
/// ANNUAL_* statuses don't surface as a labeled chip — they're filtered
/// at the indexer per spec §33.8, but defense-in-depth here too: any
/// status string we don't recognize falls through to "Active".

import Link from "next/link";

import {C, F} from "@/lib/tokens";

import type {ProfileCreatedToken} from "@/lib/arena/api";

const STATUS_META: Record<string, {label: string; color: string}> = {
  ACTIVE: {label: "Active", color: C.cyan},
  FILTERED: {label: "Filtered", color: C.red},
  WEEKLY_WINNER: {label: "Week Winner", color: C.yellow},
  QUARTERLY_FINALIST: {label: "Quarterly Finalist", color: C.purple},
  QUARTERLY_CHAMPION: {label: "Quarterly Champion", color: C.purple},
};

export function CreatedTokensList({tokens}: {tokens: ReadonlyArray<ProfileCreatedToken>}) {
  if (tokens.length === 0) {
    return (
      <div style={{color: C.dim, fontSize: 13, padding: "8px 0"}}>
        No tokens created yet.
      </div>
    );
  }
  // Sort: most recent launches first.
  const sorted = [...tokens].sort(
    (a, b) => new Date(b.launchedAt).getTime() - new Date(a.launchedAt).getTime(),
  );
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 6}}>
      {sorted.map((t) => (
        <CreatedTokenRow key={t.token} token={t} />
      ))}
    </div>
  );
}

function CreatedTokenRow({token}: {token: ProfileCreatedToken}) {
  const meta = STATUS_META[token.status] ?? STATUS_META.ACTIVE!;
  return (
    <Link
      href={`/token/${token.token}/admin`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto auto",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        textDecoration: "none",
        color: C.text,
        transition: "border-color 120ms ease",
      }}
    >
      <span style={{fontFamily: F.mono, fontWeight: 600, fontSize: 14}}>
        {token.ticker}
      </span>
      <span style={{fontSize: 11, color: C.dim, letterSpacing: "0.04em"}}>
        Season {token.seasonId}
      </span>
      <span
        style={{
          padding: "2px 8px",
          borderRadius: 999,
          background: `${meta.color}22`,
          border: `1px solid ${meta.color}66`,
          color: meta.color,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.02em",
        }}
      >
        {meta.label}
      </span>
    </Link>
  );
}
