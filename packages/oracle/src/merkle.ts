import {concat, encodePacked, keccak256, type Address, type Hex} from "viem";

/// Leaf format must match `SeasonVault.claimRollover`:
///   leaf = keccak256(abi.encodePacked(user, share))
export function rolloverLeaf(user: Address, share: bigint): Hex {
  return keccak256(encodePacked(["address", "uint256"], [user, share]));
}

/// Leaf format must match `BonusDistributor.claim`:
///   leaf = keccak256(abi.encodePacked(user, amount))
/// Same encoding as `rolloverLeaf` — kept as a separate function so caller intent is
/// explicit at the call site.
export function bonusLeaf(user: Address, amount: bigint): Hex {
  return keccak256(encodePacked(["address", "uint256"], [user, amount]));
}

/// OpenZeppelin `MerkleProof.verify` uses sorted-pair hashing: parent = keccak256(min(a,b) || max(a,b)).
/// Keep this private — `buildTree` and `getProof` are the only entry points.
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface BuiltTree {
  root: Hex;
  /// Layers ordered leaves → root. `layers[0]` is the leaf layer.
  layers: ReadonlyArray<ReadonlyArray<Hex>>;
}

/// Build a Merkle tree compatible with OZ `MerkleProof`. Odd nodes are promoted up rather
/// than duplicated — proofs for them simply skip a level, which OZ accepts.
export function buildTree(leaves: ReadonlyArray<Hex>): BuiltTree {
  if (leaves.length === 0) throw new Error("buildTree: empty leaves");
  const layers: Hex[][] = [[...leaves]];
  while (layers[layers.length - 1]!.length > 1) {
    const cur = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i]!;
      const right = cur[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    layers.push(next);
  }
  return {root: layers[layers.length - 1]![0]!, layers};
}

export function getProof(tree: BuiltTree, index: number): Hex[] {
  if (index < 0 || index >= tree.layers[0]!.length) {
    throw new Error(`getProof: index ${index} out of range`);
  }
  const proof: Hex[] = [];
  let i = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level]!;
    const sibling = i ^ 1;
    if (sibling < layer.length) proof.push(layer[sibling]!);
    // else: odd-promoted node, no sibling at this level
    i = i >> 1;
  }
  return proof;
}

/// Verify a proof against a root using OZ-compatible sorted-pair hashing. Used by tests
/// to assert the tree we built is well-formed.
export function verifyProof(leaf: Hex, proof: ReadonlyArray<Hex>, root: Hex): boolean {
  let cur: Hex = leaf;
  for (const p of proof) cur = hashPair(cur, p);
  return cur === root;
}
