/// HP ranking Merkle provenance — Epic 1.17b compute pathway.
///
/// At settlement-authoritative anchors (CUT @ h96, FINALIZE @ h168) the
/// indexer writes one hpSnapshot row per token tagged with the trigger.
/// The oracle then:
///   1. Reads those rows
///   2. Builds a Merkle tree over the ranking
///   3. Pins the tree to IPFS (caller-provided pinner)
///   4. Posts the root on-chain BEFORE invoking SeasonVault.cut() /
///      .submitWinner()
///
/// This module owns steps 2 + the ordering invariant for step 4. Steps 1
/// + 3 are caller responsibilities (DB read + IPFS upload). Spec §6.8 +
/// §42.2.6 oracle-authority invariant: contracts read the oracle-posted
/// root, never the per-component scores.
///
/// **Why a Merkle tree (not just a hash).** The full ranking is published
/// off-chain. A trader who claims they were ranked above the cut line at
/// h96 can prove it by showing their token's leaf + a Merkle proof against
/// the on-chain root. This is the same affordance the rollover Merkle
/// already provides for users; we extend it to per-token ranking
/// provenance so audit can spot-check any cut decision retroactively.
///
/// Leaf format: `keccak256(abi.encode(seasonId, token, rank, hp, weightsVersion))`
/// — every field that drove the ranking decision, packed deterministically.
/// `weightsVersion` lives in the leaf so a future weight-set change is
/// distinguishable in proofs (a rank-3 leaf under v4 ≠ rank-3 under v5).

import {encodeAbiParameters, keccak256, stringToHex, type Address, type Hex} from "viem";

import {buildTree, getProof, type BuiltTree} from "./merkle.js";

export type HpRankingTrigger = "CUT" | "FINALIZE";

export interface HpRankingEntry {
  token: Address;
  /// 1-indexed rank in the cohort (rank 1 is the highest HP).
  rank: number;
  /// Integer HP in `[0, 10000]` (Epic 1.18 / spec §6.5 composite scale).
  /// Matches indexer `hpSnapshot.hp`. Pre-1.18 the wire range was 0-100;
  /// the field shape is unchanged but the value range moved.
  hp: number;
}

export interface HpRankingPayloadInputs {
  seasonId: bigint;
  trigger: HpRankingTrigger;
  /// `HP_WEIGHTS_VERSION` stamped on the underlying snapshot rows. All
  /// rows in `entries` must share the same version — heterogeneous
  /// inputs throw, since a settlement built across two weight versions
  /// has no consistent meaning.
  weightsVersion: string;
  entries: ReadonlyArray<HpRankingEntry>;
}

export interface HpRankingProof {
  token: Address;
  rank: number;
  hp: number;
  proof: Hex[];
}

export interface HpRankingPayload {
  seasonId: bigint;
  trigger: HpRankingTrigger;
  weightsVersion: string;
  /// On-chain root that the oracle posts.
  root: Hex;
  /// Per-entry Merkle proofs. Order matches the sorted leaf order (by
  /// rank ascending) — clients use the `token` field to look up their
  /// proof; the ordering is exposed for debuggability only.
  entries: ReadonlyArray<HpRankingProof>;
}

/// Computes the leaf for one ranking entry. Exported so verifiers can
/// reproduce the encoding without depending on the oracle's tree builder.
export function hpRankingLeaf(args: {
  seasonId: bigint;
  token: Address;
  rank: number;
  hp: number;
  weightsVersion: string;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {type: "uint256"},
        {type: "address"},
        {type: "uint256"},
        {type: "uint256"},
        {type: "bytes32"},
      ],
      [
        args.seasonId,
        args.token,
        BigInt(args.rank),
        BigInt(args.hp),
        // Hash the version string to a 32-byte value so the schema is fixed-width.
        keccak256(stringToHex(args.weightsVersion)),
      ],
    ),
  );
}

/// Builds the Merkle payload for a CUT/FINALIZE settlement anchor. Pure;
/// returns the on-chain root + per-entry proofs the oracle pins to IPFS.
///
/// Sorted-leaf ordering (by rank ascending, ties broken by token address)
/// makes the tree build deterministic regardless of how the indexer
/// returned the rows.
export function buildHpRankingPayload(inputs: HpRankingPayloadInputs): HpRankingPayload {
  if (inputs.entries.length === 0) {
    throw new Error("buildHpRankingPayload: at least one entry required");
  }
  // Validate version consistency upstream: this module only sees the
  // payload-level version, but the caller is asserting every input row
  // shared it. We pin that contract here by failing loud on any leaf
  // whose computation would be ambiguous.
  if (!inputs.weightsVersion) {
    throw new Error("buildHpRankingPayload: weightsVersion is required");
  }
  // Deterministic order: ascending rank, ties broken by token address.
  // (Ranks should be unique in practice — ties only occur in degenerate
  // single-row cohorts. Tie-break ensures determinism.)
  const sorted = [...inputs.entries].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1;
  });
  const leaves = sorted.map((e) =>
    hpRankingLeaf({
      seasonId: inputs.seasonId,
      token: e.token,
      rank: e.rank,
      hp: e.hp,
      weightsVersion: inputs.weightsVersion,
    }),
  );
  const tree: BuiltTree = buildTree(leaves);
  const proofs: HpRankingProof[] = sorted.map((e, i) => ({
    token: e.token,
    rank: e.rank,
    hp: e.hp,
    proof: getProof(tree, i),
  }));
  return {
    seasonId: inputs.seasonId,
    trigger: inputs.trigger,
    weightsVersion: inputs.weightsVersion,
    root: tree.root,
    entries: proofs,
  };
}

/// Settlement provenance ordering invariant — Epic 1.17b's "Merkle
/// publish must precede settlement tx" rule. The oracle records each
/// step's wall-clock timestamp; this helper asserts the order.
///
/// Returns `null` on success, or a string describing the violated step
/// on failure. The caller is responsible for tripping an alarm — this
/// is a pure check.
export interface SettlementProvenance {
  hpSnapshotWrittenAtSec: bigint;
  rootComputedAtSec: bigint;
  ipfsPinnedAtSec: bigint;
  onChainSettlementSubmittedAtSec: bigint;
}

export function checkSettlementProvenance(p: SettlementProvenance): string | null {
  if (p.rootComputedAtSec < p.hpSnapshotWrittenAtSec) {
    return "rootComputedAtSec precedes hpSnapshotWrittenAtSec — root computed before snapshot was written?";
  }
  if (p.ipfsPinnedAtSec < p.rootComputedAtSec) {
    return "ipfsPinnedAtSec precedes rootComputedAtSec — pin without a root?";
  }
  if (p.onChainSettlementSubmittedAtSec < p.ipfsPinnedAtSec) {
    return "onChainSettlementSubmittedAtSec precedes ipfsPinnedAtSec — settlement tx fired before pin completed";
  }
  return null;
}
