import {describe, expect, it} from "vitest";
import {concat, keccak256, type Address, type Hex} from "viem";

import {buildTree, getProof, rolloverLeaf, verifyProof} from "../src/merkle.js";

function pair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";
const C: Address = "0x3333333333333333333333333333333333333333";

describe("rolloverLeaf", () => {
  it("matches the contract's keccak256(abi.encodePacked(user, share)) encoding", () => {
    // Independently encode: 20 bytes (user) || 32 bytes (uint256 share, big-endian)
    const userBytes = "1111111111111111111111111111111111111111";
    const shareBytes = (50n).toString(16).padStart(64, "0");
    const expected = keccak256(`0x${userBytes}${shareBytes}` as Hex);
    expect(rolloverLeaf(A, 50n)).toBe(expected);
  });
});

describe("buildTree", () => {
  it("returns the only leaf as the root for a single-leaf tree", () => {
    const leaf = rolloverLeaf(A, 1n);
    const tree = buildTree([leaf]);
    expect(tree.root).toBe(leaf);
    expect(tree.layers).toHaveLength(1);
  });

  it("matches a hand-computed two-leaf root with sorted-pair hashing", () => {
    const l0 = rolloverLeaf(A, 50n);
    const l1 = rolloverLeaf(B, 30n);
    const tree = buildTree([l0, l1]);
    expect(tree.root).toBe(pair(l0, l1));
  });

  it("promotes odd-count nodes up the tree without duplication", () => {
    const l0 = rolloverLeaf(A, 50n);
    const l1 = rolloverLeaf(B, 30n);
    const l2 = rolloverLeaf(C, 20n);
    const tree = buildTree([l0, l1, l2]);
    // Layer 1: [pair(l0,l1), l2]; root = pair(pair(l0,l1), l2)
    expect(tree.root).toBe(pair(pair(l0, l1), l2));
  });
});

describe("getProof + verifyProof", () => {
  it("round-trips a 2-leaf proof", () => {
    const leaves = [rolloverLeaf(A, 50n), rolloverLeaf(B, 30n)];
    const tree = buildTree(leaves);
    expect(verifyProof(leaves[0]!, getProof(tree, 0), tree.root)).toBe(true);
    expect(verifyProof(leaves[1]!, getProof(tree, 1), tree.root)).toBe(true);
  });

  it("round-trips proofs in an odd-sized tree (the promoted leaf has a shorter proof)", () => {
    const leaves = [rolloverLeaf(A, 50n), rolloverLeaf(B, 30n), rolloverLeaf(C, 20n)];
    const tree = buildTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyProof(leaves[i]!, getProof(tree, i), tree.root)).toBe(true);
    }
    // The promoted leaf at the boundary skips its first level, so its proof is shorter.
    expect(getProof(tree, 2).length).toBeLessThan(getProof(tree, 0).length);
  });

  it("rejects a tampered leaf", () => {
    const leaves = [rolloverLeaf(A, 50n), rolloverLeaf(B, 30n)];
    const tree = buildTree(leaves);
    const wrongLeaf = rolloverLeaf(A, 51n);
    expect(verifyProof(wrongLeaf, getProof(tree, 0), tree.root)).toBe(false);
  });
});
