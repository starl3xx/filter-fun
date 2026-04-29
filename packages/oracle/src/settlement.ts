import type {Address} from "viem";

import {buildTree, getProof, rolloverLeaf} from "./merkle.js";
import type {
  FilterEventInputs,
  FilterEventPayload,
  RolloverEntry,
  SettlementInputs,
  SettlementPayload,
} from "./types.js";

const BPS_DENOMINATOR = 10_000n;

/// Build the calldata-shaped payload for one filter event. Caller chooses which tokens to
/// cut at this event, produces per-loser recoverable-WETH quotes, and picks a slippage budget.
/// The vault liquidates these and applies the user-aligned BPS split (45/25/10/10/10) — POL
/// accumulates as WETH, no winner is set yet.
export function buildFilterEventPayload(inputs: FilterEventInputs): FilterEventPayload {
  if (inputs.losers.length === 0) {
    throw new Error("buildFilterEventPayload: at least one loser required");
  }
  if (inputs.slippageBps < 0 || inputs.slippageBps >= 10_000) {
    throw new Error(`buildFilterEventPayload: slippageBps ${inputs.slippageBps} out of range`);
  }

  const minOuts: bigint[] = inputs.losers.map((t) => {
    const r = inputs.recoverable.get(t);
    if (r === undefined) {
      throw new Error(`buildFilterEventPayload: no recoverable quote for ${t}`);
    }
    return (r * (BPS_DENOMINATOR - BigInt(inputs.slippageBps))) / BPS_DENOMINATOR;
  });

  return {losers: inputs.losers, minOuts};
}

/// Build the calldata-shaped payload + sidecar Merkle tree for `SeasonVault.submitWinner`.
/// `shares` is the cumulative per-wallet rollover weight aggregated across ALL filter events
/// of the season. The vault drains the accumulated rollover/bonus/POL reserves at this call.
///
/// Knows nothing about scoring or snapshot policy — does only the deterministic transform
/// from inputs → on-chain calldata + claim artifact.
export function buildSettlementPayload(inputs: SettlementInputs): SettlementPayload {
  // Sort by user address (lower-cased lexicographically) so the tree is deterministic
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
    winner: inputs.winner,
    rolloverRoot: tree.root,
    totalRolloverShares: totalShares,
    minWinnerTokensRollover: inputs.minWinnerTokensRollover ?? 0n,
    minWinnerTokensPol: inputs.minWinnerTokensPol ?? 0n,
    tree: {root: tree.root, totalShares, entries: fullEntries},
  };
}

// Re-export Address for downstream consumers that import this module directly.
export type {Address};
