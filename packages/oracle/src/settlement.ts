import type {Address} from "viem";

import {buildTree, getProof, rolloverLeaf} from "./merkle.js";
import type {RolloverEntry, SettlementInputs, SettlementPayload} from "./types.js";

const BPS_DENOMINATOR = 10_000n;

/// Build the calldata-shaped payload + sidecar Merkle tree for `SeasonVault.submitSettlement`.
/// Caller is responsible for: choosing the winner (here: `ranking[0]`), producing per-loser
/// recoverable USDC quotes, and computing the per-wallet `share` weights from holder snapshots.
///
/// This module deliberately knows nothing about scoring algorithm or holder snapshot policy —
/// it only does the deterministic transform from inputs → on-chain calldata + claim artifact.
export function buildSettlementPayload(inputs: SettlementInputs): SettlementPayload {
  if (inputs.ranking.length < 2) {
    throw new Error("buildSettlementPayload: ranking must include a winner and ≥1 loser");
  }
  if (inputs.slippageBps < 0 || inputs.slippageBps >= 10_000) {
    throw new Error(`buildSettlementPayload: slippageBps ${inputs.slippageBps} out of range`);
  }

  const winner = inputs.ranking[0]!;
  const losers: Address[] = inputs.ranking.slice(1);

  const minOuts: bigint[] = losers.map((t) => {
    const r = inputs.recoverable.get(t);
    if (r === undefined) {
      throw new Error(`buildSettlementPayload: no recoverable quote for ${t}`);
    }
    return (r * (BPS_DENOMINATOR - BigInt(inputs.slippageBps))) / BPS_DENOMINATOR;
  });

  // Sort entries by user address (lower-cased lexicographically) so the tree is deterministic
  // regardless of map iteration order.
  const entries = [...inputs.shares.entries()]
    .filter(([, share]) => share > 0n)
    .map(([user, share]) => ({user, share}))
    .sort((a, b) => (a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1));

  if (entries.length === 0) {
    throw new Error("buildSettlementPayload: no positive shares — nothing to roll over");
  }

  const totalShares = entries.reduce((s, e) => s + e.share, 0n);
  const leaves = entries.map((e) => rolloverLeaf(e.user, e.share));
  const tree = buildTree(leaves);

  const fullEntries: RolloverEntry[] = entries.map((e, i) => ({
    user: e.user,
    share: e.share,
    proof: getProof(tree, i),
  }));

  return {
    winner,
    losers,
    minOuts,
    rolloverRoot: tree.root,
    totalRolloverShares: totalShares,
    liquidationDeadline: inputs.liquidationDeadline,
    tree: {root: tree.root, totalShares, entries: fullEntries},
  };
}
