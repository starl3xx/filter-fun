// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Tiny Merkle helper for two-leaf trees. Matches OZ's `MerkleProof.verify` ordering
///         (sibling pairs are sorted before hashing).
library MiniMerkle {
    function rootOfTwo(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function proofForTwo(bytes32[2] memory leaves, uint256 idx)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        proof = new bytes32[](1);
        proof[0] = leaves[idx == 0 ? 1 : 0];
    }
}
