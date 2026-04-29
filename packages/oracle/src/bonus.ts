import type {Address, Hex} from "viem";

import {bonusLeaf, buildTree, getProof} from "./merkle.js";

const BPS_DENOMINATOR = 10_000n;

export interface BonusEntry {
  user: Address;
  /// WETH bonus amount this user can claim. Final, integer-rounded — leaf is
  /// `keccak256(abi.encodePacked(user, amount))`.
  amount: bigint;
  proof: ReadonlyArray<Hex>;
}

export interface BonusPayload {
  /// Pass to `BonusDistributor.postRoot(seasonId, root)`.
  root: Hex;
  /// Per-eligible-holder claim data. Holders not present in `entries` are not eligible
  /// (failed the hold threshold across one or more snapshots).
  entries: ReadonlyArray<BonusEntry>;
  /// Sum of `entries[i].amount`. Equals `totalReserve` minus the integer-division dust
  /// (a few wei). The dust stays in the BonusDistributor contract.
  totalAllocated: bigint;
}

export interface BonusInputs {
  /// Per-snapshot wallet → balance. The oracle takes 3–5 unannounced snapshots during
  /// the 14-day hold window; eligibility uses the MIN balance across all of them.
  snapshots: ReadonlyArray<ReadonlyMap<Address, bigint>>;
  /// Per-holder rolledAmount: winner tokens received via `SeasonVault.claimRollover`.
  /// Holders not in this map cannot earn the bonus (didn't claim rollover).
  rolledByHolder: ReadonlyMap<Address, bigint>;
  /// Hold threshold: holder's min snapshot balance must be ≥ this fraction of their
  /// rolledAmount. Spec says 80%; default 8000 BPS.
  holdThresholdBps?: number;
  /// Total bonus reserve in WETH. Read off-chain from `BonusDistributor.bonusOf(seasonId).reserve`.
  totalReserve: bigint;
}

/// Build the bonus settlement: filter to eligible holders (held ≥ threshold% of their
/// rolled amount across all snapshots), allocate the reserve pro-rata by rolledAmount,
/// build the OZ-compatible Merkle tree.
///
/// Pro-rata-by-rolledAmount is the policy choice baked in here: holders who rolled more
/// get a proportionally larger bonus (conditional on holding). This matches the spec's
/// "rolled tokens" framing and avoids a per-wallet uniform amount being game-able by
/// splitting balances across many addresses.
export function buildBonusPayload(inputs: BonusInputs): BonusPayload {
  if (inputs.snapshots.length === 0) {
    throw new Error("buildBonusPayload: snapshots must be non-empty");
  }
  if (inputs.totalReserve <= 0n) {
    throw new Error("buildBonusPayload: totalReserve must be > 0");
  }
  const thresholdBps = BigInt(inputs.holdThresholdBps ?? 8000);
  if (thresholdBps < 0n || thresholdBps > BPS_DENOMINATOR) {
    throw new Error(`buildBonusPayload: holdThresholdBps ${inputs.holdThresholdBps} out of range`);
  }

  // 1. Eligibility: min balance across all snapshots ≥ thresholdBps * rolled / 10_000.
  //    Compare via cross-multiplication to keep everything in bigint.
  const eligible: Array<{user: Address; weight: bigint}> = [];
  for (const [user, rolled] of inputs.rolledByHolder) {
    if (rolled <= 0n) continue;
    let minBal = inputs.snapshots[0]!.get(user) ?? 0n;
    for (let i = 1; i < inputs.snapshots.length; i++) {
      const bal = inputs.snapshots[i]!.get(user) ?? 0n;
      if (bal < minBal) minBal = bal;
    }
    if (minBal * BPS_DENOMINATOR >= rolled * thresholdBps) {
      eligible.push({user, weight: rolled});
    }
  }

  if (eligible.length === 0) {
    throw new Error("buildBonusPayload: no eligible holders — every holder failed the threshold");
  }

  // 2. Sort by user address for deterministic tree construction.
  eligible.sort((a, b) => (a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1));

  // 3. Pro-rata allocation. Integer division leaves a few wei of dust in the contract;
  //    that's by design — preferable to a more complex residual-distribution scheme.
  const totalWeight = eligible.reduce((s, e) => s + e.weight, 0n);
  const amounts = eligible.map((e) => (e.weight * inputs.totalReserve) / totalWeight);
  const totalAllocated = amounts.reduce((s, a) => s + a, 0n);

  // 4. Build Merkle tree.
  const leaves = eligible.map((e, i) => bonusLeaf(e.user, amounts[i]!));
  const tree = buildTree(leaves);

  const entries: BonusEntry[] = eligible.map((e, i) => ({
    user: e.user,
    amount: amounts[i]!,
    proof: getProof(tree, i),
  }));

  return {root: tree.root, entries, totalAllocated};
}
