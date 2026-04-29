"use client";

import type {Address, Hex} from "viem";

import {claimBonusCall} from "@filter-fun/scheduler";

import {ClaimForm, type ParsedClaim} from "@/components/ClaimForm";

/// Expected JSON shape (matches the per-user entries in the oracle's published bonus file):
///   { "seasonId": "1", "distributor": "0x…", "amount": "1000000000000000000", "proof": ["0x…"] }
function parseBonus(raw: string): ParsedClaim {
  const obj = JSON.parse(raw) as unknown;
  if (typeof obj !== "object" || obj === null) throw new Error("payload must be a JSON object");
  const o = obj as Record<string, unknown>;
  if (typeof o.seasonId !== "string" && typeof o.seasonId !== "number") {
    throw new Error("seasonId must be a string or number");
  }
  if (typeof o.distributor !== "string") throw new Error("distributor must be a string");
  if (typeof o.amount !== "string" && typeof o.amount !== "number") {
    throw new Error("amount must be a string or number");
  }
  if (!Array.isArray(o.proof) || !o.proof.every((p) => typeof p === "string")) {
    throw new Error("proof must be an array of hex strings");
  }
  return {
    seasonId: BigInt(o.seasonId),
    contract: o.distributor as Address,
    numeric: BigInt(o.amount),
    proof: o.proof as Hex[],
  };
}

export default function ClaimBonusPage() {
  return (
    <ClaimForm
      title="Claim hold bonus"
      subtitle="Holders of ≥80% of their rolled tokens for 14 days earn a slice of the WETH bonus reserve."
      numericLabel="Amount (wei)"
      parseJson={parseBonus}
      buildCall={(c) => claimBonusCall(c.contract, c.seasonId, c.numeric, c.proof)}
    />
  );
}
