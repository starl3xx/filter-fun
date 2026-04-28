// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Brute-force search for a CREATE2 salt that produces a hook address whose lower 14
///         bits encode the requested permission flags. V4 routes hook calls based on these bits.
///
///         For `FilterHook` we need flags = `BEFORE_ADD_LIQUIDITY (1<<11) | BEFORE_REMOVE_LIQUIDITY (1<<9)`
///         = 0xA00. Probability of a random address matching = 1/16384, so the search typically
///         completes in a few thousand iterations.
library HookMiner {
    uint160 internal constant FLAG_MASK = 0x3FFF;

    error SaltNotFound();

    /// @param deployer The address that will execute the CREATE2 deployment.
    /// @param flags Required value of `addr & 0x3FFF`.
    /// @param creationCode Hook contract's creation code (no constructor args, since `FilterHook`
    ///        takes none and is wired post-construction via `initialize()`).
    function find(address deployer, uint160 flags, bytes memory creationCode)
        internal
        pure
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 codeHash = keccak256(creationCode);
        for (uint256 i = 0; i < 200_000; ++i) {
            salt = bytes32(i);
            hookAddress = _computeAddress(deployer, salt, codeHash);
            if ((uint160(hookAddress) & FLAG_MASK) == flags) {
                return (hookAddress, salt);
            }
        }
        revert SaltNotFound();
    }

    function _computeAddress(address deployer, bytes32 salt, bytes32 codeHash)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, codeHash)))));
    }
}
