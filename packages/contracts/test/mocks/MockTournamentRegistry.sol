// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test stand-in for TournamentRegistry. Records calls + arg snapshots so unit tests
///         can assert that SeasonVault.markFiltered / submitWinner correctly forward to the
///         registry. No auth — tests can prank from the registered SeasonVault directly.
contract MockTournamentRegistry {
    struct WinnerCall {
        uint256 seasonId;
        address token;
    }

    struct FilteredCall {
        uint256 seasonId;
        address token;
    }

    WinnerCall public lastWinner;
    uint256 public winnerCallCount;

    mapping(address => uint256) public filteredCount;
    FilteredCall public lastFiltered;
    uint256 public filteredCallCount;

    function recordWeeklyWinner(uint256 seasonId, address token) external {
        lastWinner = WinnerCall({seasonId: seasonId, token: token});
        ++winnerCallCount;
    }

    function markFiltered(uint256 seasonId, address token) external {
        ++filteredCount[token];
        lastFiltered = FilteredCall({seasonId: seasonId, token: token});
        ++filteredCallCount;
    }
}
