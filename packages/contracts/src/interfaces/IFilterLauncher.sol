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

    function currentSeasonId() external view returns (uint256);
    function phaseOf(uint256 seasonId) external view returns (Phase);
    function vaultOf(uint256 seasonId) external view returns (address);
    function tokensInSeason(uint256 seasonId) external view returns (address[] memory);
    function entryOf(uint256 seasonId, address token) external view returns (TokenEntry memory);
}
