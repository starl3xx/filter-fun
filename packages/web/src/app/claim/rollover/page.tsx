"use client";

import type {Address, Hex} from "viem";

import {claimRolloverCall, SeasonVaultAbi} from "@filter-fun/scheduler";

import {ClaimForm, type ParsedClaim} from "@/components/ClaimForm";
import {validateProof} from "@/lib/claim/validateProof";

/// Expected JSON shape (matches the per-user entries in the oracle's published settlement file):
///   { "seasonId": "1", "vault": "0x…", "share": "100", "proof": ["0x…"] }
/// All bigints arrive as strings — JSON has no native bigint.
function parseRollover(raw: string): ParsedClaim {
  const obj = JSON.parse(raw) as unknown;
  if (typeof obj !== "object" || obj === null) throw new Error("payload must be a JSON object");
  const o = obj as Record<string, unknown>;
  if (typeof o.seasonId !== "string" && typeof o.seasonId !== "number") {
    throw new Error("seasonId must be a string or number");
  }
  if (typeof o.vault !== "string") throw new Error("vault must be a string");
  if (typeof o.share !== "string" && typeof o.share !== "number") {
    throw new Error("share must be a string or number");
  }
  // Audit H-Web-3 — bounds + per-item hex check via shared validator. Pre-fix
  // only `Array.isArray` + every-item is-string; let through empty arrays,
  // 10000-element OOM bombs, and non-hex strings.
  validateProof(o.proof);
  return {
    seasonId: BigInt(o.seasonId),
    contract: o.vault as Address,
    numeric: BigInt(o.share),
    proof: o.proof as Hex[],
  };
}

export default function ClaimRolloverPage() {
  return (
    <ClaimForm
      title="Claim rollover"
      subtitle="Half of every losing token's recovered LP rolls into the winner — your share is paid in winner tokens."
      numericLabel="Share"
      jsonPlaceholder='{"seasonId": "1", "vault": "0x…", "share": "100", "proof": ["0x…"]}'
      parseJson={parseRollover}
      buildCall={(c) => claimRolloverCall(c.contract, c.numeric, c.proof)}
      buildClaimedRead={(c, user) => ({
        address: c.contract,
        abi: SeasonVaultAbi,
        functionName: "claimed",
        args: [user],
      })}
    />
  );
}
