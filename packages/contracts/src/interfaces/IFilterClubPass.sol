// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IFilterClubPass
/// @notice Minimal launcher-facing surface of the Filter Club lifetime pass (spec §47.3.8).
///         The launcher consults the pass exactly once, inside `reserve`'s payment check,
///         when `msg.value == 0`. Kept to a single function so importing it costs the
///         launcher as little runtime bytecode as possible (EIP-170 budget).
interface IFilterClubPass {
    /// @notice Consume one free-launch credit held by `holder` for `seasonId`.
    /// @dev    MUST be restricted to the wired launcher. MUST return false — never revert —
    ///         when no credit is available (no owned pass with credits, or the per-season
    ///         redemption cap is reached), so the launcher keeps a single
    ///         `InsufficientEscrow` error surface for every unfunded reservation.
    ///         Implementations record `(seasonId, holder) → tokenId` so the credit can be
    ///         trustlessly restored via `reclaimCredit` if the season aborts.
    /// @param  holder   The reserving wallet (`msg.sender` of `reserve`).
    /// @param  seasonId Season the reservation is entering.
    /// @return consumed True if a credit was found and decremented in this call.
    function consumeCredit(address holder, uint256 seasonId) external returns (bool consumed);
}
