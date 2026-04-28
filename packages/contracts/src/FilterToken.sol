// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FilterToken
/// @notice Plain ERC-20 deployed by `FilterFactory`. Total supply is minted once at construction
///         and immediately seeded into a Uniswap V4 pool — no further minting and no privileged
///         roles. Identical bytecode for every filter.fun launch (including $FILTER).
contract FilterToken is ERC20 {
    string public metadataURI;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address mintTo,
        string memory metadataURI_
    ) ERC20(name_, symbol_) {
        metadataURI = metadataURI_;
        _mint(mintTo, initialSupply);
    }
}
