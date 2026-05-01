"use client";

import type {SeasonResponse, TokenResponse} from "@/lib/arena/api";
import type {TokenStats} from "@/hooks/token/useTokenStats";
import {C, F} from "@/lib/tokens";

import {Card, Field} from "./Card";

/// Live settlement preview — what would happen if finals ended right now.
/// Visible only during the Finals phase (otherwise the preview would either
/// be premature or already finalised). Uses the cohort served by `/tokens`
/// + the season's `championPool` for projection.
///
/// This is intentionally a low-precision estimate: the real settlement runs
/// on `seasonVault.submitWinner` with mid-flight oracle data, not the
/// indexer's last poll. The phrasing is hedged ("If finals end now…") to
/// signal that.

export type SettlementPreviewProps = {
  stats: TokenStats;
  cohort: TokenResponse[];
  season: SeasonResponse | null;
};

export function SettlementPreview({stats, cohort, season}: SettlementPreviewProps) {
  if (!season || !stats.token) return null;
  const isFinals = season.phase === "finals";
  if (!isFinals) return null;

  const isWinner = stats.token.rank === 1;
  const isFiltered = stats.cutLineStatus === "FILTERED";
  const winner = cohort.find((t) => t.rank === 1) ?? null;
  const winnerLabel = winner?.ticker ?? "—";

  return (
    <Card label="Settlement preview">
      <p style={{margin: "0 0 10px", fontSize: 11, color: C.faint, fontFamily: F.mono, letterSpacing: "0.06em"}}>
        IF FINALS END NOW
      </p>
      <Field
        k="Outcome"
        v={
          isWinner ? (
            <span style={{color: C.yellow}}>winner</span>
          ) : isFiltered ? (
            <span style={{color: C.red}}>filtered</span>
          ) : (
            <span style={{color: C.dim}}>finalist · not winning</span>
          )
        }
      />
      <Field k="Rank" v={`#${stats.token.rank}`} />
      {!isWinner && winner && (
        <Field
          k="Holders rollover to"
          v={
            <span style={{color: C.cyan}}>{winnerLabel}</span>
          }
        />
      )}
      <p
        style={{
          marginTop: 10,
          fontSize: 11,
          color: C.faint,
          fontFamily: F.display,
          lineHeight: 1.5,
        }}
      >
        Live estimate. Final state is locked when the oracle calls
        <code style={{fontFamily: F.mono}}> submitWinner</code> at hour 168.
      </p>
    </Card>
  );
}
