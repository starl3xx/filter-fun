"use client";

import type {Address, Hex} from "viem";

import {claimRolloverCall, SeasonVaultAbi} from "@filter-fun/scheduler";

import {ClaimForm, type ParsedClaim} from "@/components/ClaimForm";
import {toIntegerBigInt} from "@/lib/claim/parseInteger";
import {validateProof} from "@/lib/claim/validateProof";
import {C} from "@/lib/tokens";

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
    // Audit M-Web-4 (Phase 1, 2026-05-02): `BigInt("1.5")` throws an opaque
    // SyntaxError that the user sees as "Cannot convert 1.5 to a BigInt".
    // `toIntegerBigInt` rejects fractional / NaN / non-finite numbers and
    // empty / non-numeric strings up front with a field-named message.
    seasonId: toIntegerBigInt(o.seasonId, "seasonId"),
    contract: o.vault as Address,
    numeric: toIntegerBigInt(o.share, "share"),
    proof: o.proof as Hex[],
  };
}

export default function ClaimRolloverPage() {
  // Audit M-Ux-10 (Phase 1, 2026-05-03): users who lose their claim JSON
  // (deleted email, lost the copy from the post-filter card, switched
  // devices) had no recovery path pre-fix — the form just presents an
  // empty textarea with no hint about what to do if they don't have the
  // JSON anymore. The footer link points to the per-season claims
  // directory in the docs site, where each season's full settlement file
  // is mirrored and indexable by wallet address.
  //
  // Bugbot (PR #81 round 2): pre-fix the footer rendered as a fragment
  // sibling of `<ClaimForm/>`, which placed it OUTSIDE ClaimForm's
  // `<main>` element and stretched it to full viewport width while the
  // form above was 720px-capped via globals.css. Routed through
  // ClaimForm's `footerSlot` so it inherits the same constraint.
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
      footerSlot={<ClaimRecoveryFooter />}
    />
  );
}

function ClaimRecoveryFooter() {
  return (
    <p style={{marginTop: 32, color: C.dim, fontSize: 13, textAlign: "center"}}>
      Need your claim JSON again?{" "}
      <a
        href="https://docs.filter.fun/claims/recovery"
        target="_blank"
        rel="noopener noreferrer"
        style={{color: C.cyan, textDecoration: "underline"}}
      >
        Look it up by wallet in the claims directory →
      </a>
    </p>
  );
}
