/// Audit H-Web-3 (Phase 1, 2026-05-01) — Merkle proof validator shared by
/// every claim surface (`/claim/rollover`, `/claim/bonus`, future seasonal
/// payouts). Pre-fix the claim pages only checked `Array.isArray` + every-item
/// is-string, which let through:
///   - empty arrays (contract reverts with an opaque "invalid proof" anyway,
///     but the wallet shows a confusing gas estimate first)
///   - 10000-element arrays that OOM the wallet RPC during gas estimation
///   - non-hex strings (revert with confusing on-chain error)
///   - wrong-length hex strings (same)
///
/// `MAX_PROOF_LENGTH = 32` corresponds to a Merkle tree of depth 32 — i.e.
/// up to 2^32 ≈ 4.3 billion leaves, far more than any realistic season's
/// claim cohort. Pinned as a constant so a future season's tree growth can't
/// silently exceed the cap without an explicit code change.

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export const MAX_PROOF_LENGTH = 32;

/// Asserts `proof` is a non-empty array of 0x-prefixed 32-byte hex strings,
/// no more than `MAX_PROOF_LENGTH` items long. Throws with a user-readable
/// message on any failure — callers wrap the throw and surface it through
/// the existing claim-form error banner.
///
/// `asserts proof is …` narrows the type at the call site so consumers don't
/// need a separate cast after the validate call.
export function validateProof(proof: unknown): asserts proof is `0x${string}`[] {
  if (!Array.isArray(proof)) {
    throw new Error("proof must be an array");
  }
  if (proof.length === 0) {
    throw new Error("proof cannot be empty");
  }
  if (proof.length > MAX_PROOF_LENGTH) {
    throw new Error(
      `proof too long (${proof.length} items, max ${MAX_PROOF_LENGTH})`,
    );
  }
  for (let i = 0; i < proof.length; i++) {
    const p = proof[i];
    if (typeof p !== "string" || !HEX32.test(p)) {
      throw new Error(
        `proof[${i}] must be a 32-byte hex string (0x-prefixed, 64 hex chars)`,
      );
    }
  }
}
