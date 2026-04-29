// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IFilterLauncher {
    enum Phase {
        Launch,
        Filter,
        Finals,
        Settlement,
        Closed
    }

    struct TokenEntry {
        address token;
        address pool;
        address feeSplitter;
        address creator;
        bool isProtocolLaunched;
        bool isFinalist;
    }

    /// @notice Per-launch metadata captured by the capped launch system. Sits alongside
    ///         `TokenEntry`; `TokenEntry` describes the token, this describes the launch slot.
    struct LaunchInfo {
        uint64 slotIndex;
        uint128 costPaid;
        uint128 stakeAmount;
        bool refunded;
        bool filteredEarly;
    }

    struct LaunchStatus {
        uint256 launchCount;
        uint256 maxLaunches;
        uint256 timeRemaining;
        uint256 nextLaunchCost;
    }

    function currentSeasonId() external view returns (uint256);
    function phaseOf(uint256 seasonId) external view returns (Phase);
    function vaultOf(uint256 seasonId) external view returns (address);
    function tokensInSeason(uint256 seasonId) external view returns (address[] memory);
    function entryOf(uint256 seasonId, address token) external view returns (TokenEntry memory);
    function launchInfoOf(uint256 seasonId, address token) external view returns (LaunchInfo memory);
    function getLaunchStatus(uint256 seasonId) external view returns (LaunchStatus memory);
}
