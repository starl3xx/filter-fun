"use client";

import type {Address, Hex} from "viem";

import {BonusDistributorAbi, claimBonusCall} from "@filter-fun/scheduler";

import {ClaimForm, type ParsedClaim} from "@/components/ClaimForm";
import {toIntegerBigInt} from "@/lib/claim/parseInteger";
import {validateProof} from "@/lib/claim/validateProof";
import {C, F} from "@/lib/tokens";

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
  // Audit H-Web-3 — bounds + per-item hex check via shared validator. Pre-fix
  // only `Array.isArray` + every-item is-string; let through empty arrays,
  // 10000-element OOM bombs, and non-hex strings.
  validateProof(o.proof);
  return {
    // Audit M-Web-4 (Phase 1, 2026-05-02): integer guard — see rollover page
    // header note. `amount` is wei here; the oracle never publishes a
    // fractional wei but a hostile / malformed JSON could.
    seasonId: toIntegerBigInt(o.seasonId, "seasonId"),
    contract: o.distributor as Address,
    numeric: toIntegerBigInt(o.amount, "amount"),
    proof: o.proof as Hex[],
  };
}

export default function ClaimBonusPage() {
  return (
    <>
      {/* Audit L-Ux-1 (Phase 1, 2026-05-03): the 14-day hold window
          gates eligibility. Pre-fix the user had no way to see when
          their bonus opens — a wallet that submits before the window
          opens hits an on-chain revert (mapped by humanizeClaimError
          to a friendly message, but better to prevent the round trip
          entirely). The static card below explains the cycle so a
          newly-rolled holder knows to wait. A future enhancement
          would read `bonusOpensAt(seasonId)` from the BonusDistributor
          and render an exact local-time "Bonus opens at…" countdown
          here; not in scope for Phase 1 (no public indexer endpoint
          exists for that read yet, and adding one is its own ticket). */}
      <BonusWindowCard />
      <ClaimForm
        title="Claim hold bonus"
        subtitle="Holders of ≥80% of their rolled tokens for 14 days earn a slice of the WETH bonus reserve."
        numericLabel="Amount (wei)"
        jsonPlaceholder='{"seasonId": "1", "distributor": "0x…", "amount": "1000000000000000000", "proof": ["0x…"]}'
        parseJson={parseBonus}
        buildCall={(c) => claimBonusCall(c.contract, c.seasonId, c.numeric, c.proof)}
        buildClaimedRead={(c, user) => ({
          address: c.contract,
          abi: BonusDistributorAbi,
          functionName: "claimed",
          args: [c.seasonId, user],
        })}
      />
    </>
  );
}

function BonusWindowCard() {
  return (
    <section
      aria-label="When can I claim my bonus?"
      style={{
        marginBottom: 24,
        padding: "12px 14px",
        borderRadius: 8,
        border: `1px solid ${C.cyan}66`,
        background: `${C.cyan}14`,
        fontSize: 13,
        color: C.text,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: 10,
          letterSpacing: "0.16em",
          color: C.cyan,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        When does this open?
      </div>
      <p style={{margin: 0, color: C.dim}}>
        The hold bonus unlocks <strong style={{color: C.text}}>14 days after the rollover</strong> — your wallet must hold ≥80% of its rolled tokens through that window. The oracle publishes claim JSON ~30 seconds after the window closes; if you're early, the contract reverts and the bonus stays in the reserve until you can claim.
      </p>
    </section>
  );
}
