// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {CreatorCommitments} from "./CreatorCommitments.sol";

/// @title FilterToken
/// @notice Plain ERC-20 deployed by `FilterFactory`. Total supply is minted once at construction
///         and immediately seeded into a Uniswap V4 pool — no further minting and no privileged
///         roles. Identical bytecode for every filter.fun launch (including $FILTER).
///
///         Bag-lock gating (Epic 1.13, spec §38.5/§38.8): an immutable reference to the
///         singleton `CreatorCommitments` contract is wired in by the factory. On every
///         transfer (other than mint) the token consults `commitments.isLocked(from, self)`
///         and reverts if the FROM address is currently locked. The lock applies to the FROM
///         address only — pre-commit transfers and any wallet that holds tokens but didn't
///         call `commit` are unaffected. See docs/bag-lock.md for the operator-facing
///         contract.
contract FilterToken is ERC20 {
    /// @notice Singleton commitments contract this token consults on every non-mint transfer.
    ///         Wired immutably by the factory at deploy time so the gating address can never
    ///         be re-pointed; if a security issue ever requires moving to a new commitments
    ///         contract, the only path is a new factory + new tokens.
    CreatorCommitments public immutable commitments;

    string public metadataURI;

    error TransferLocked(address from, uint256 unlockAt);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address mintTo,
        string memory metadataURI_,
        CreatorCommitments commitments_
    ) ERC20(name_, symbol_) {
        commitments = commitments_;
        metadataURI = metadataURI_;
        _mint(mintTo, initialSupply);
    }

    /// @dev OZ v5 routes every balance change — mint, burn, transfer, transferFrom — through
    ///      `_update`. Mints (`from == address(0)`) bypass the gate so the constructor's
    ///      `_mint` to the factory still works after a creator has somehow committed (which
    ///      can't happen during construction anyway, but the check keeps the invariant
    ///      explicit). Every other path consults `isLocked(from, self)` and reverts via a
    ///      typed error that includes the unlock timestamp — useful for both indexer logs and
    ///      wallet-side error decoding.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && commitments.isLocked(from, address(this))) {
            revert TransferLocked(from, commitments.unlockOf(from, address(this)));
        }
        super._update(from, to, value);
    }
}
