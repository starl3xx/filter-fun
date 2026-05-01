"use client";

import type {SeasonResponse} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

import {Card, Field} from "./Card";

/// Champion bounty + POL backing projections for the connected token.
///
/// Math is admittedly napkin-grade for v1:
///   - Champion bounty = 2.5% of `championPool` (spec §11.1).
///   - POL backing    = `polReserve` (POL Vault accumulates throughout the
///     season and deploys 100% into the winner's pool at settlement).
///
/// Both numbers are projections under the assumption that this token wins
/// the week; the copy frames it that way. A losing token sees the same
/// numbers but they're informational about what the WINNER will receive.

export type BountyEstimateProps = {
  season: SeasonResponse | null;
  isWinner: boolean;
};

export function BountyEstimate({season, isWinner}: BountyEstimateProps) {
  if (!season) return null;
  const championPool = parseFloat(season.championPool || "0");
  const polReserve = parseFloat(season.polReserve || "0");
  const bounty = championPool * 0.025;

  return (
    <Card label="Win projection">
      <p style={{margin: "0 0 8px", fontSize: 11, color: C.faint, fontFamily: F.mono, letterSpacing: "0.06em"}}>
        {isWinner ? "AT THE FRONT — IF YOU HOLD THE LINE" : "IF YOU WIN THIS WEEK"}
      </p>
      <Field k="Champion bounty" v={`~${bounty.toFixed(3)} ETH`} />
      <Field k="POL backing" v={`~${polReserve.toFixed(2)} ETH`} />
      <p style={{marginTop: 10, fontSize: 11, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        Bounty is 2.5% of the losers pot, paid to the winning token's creator.
        POL is deployed as permanent V4 LP on the winner's pool — locked, never withdrawn.
      </p>
    </Card>
  );
}
