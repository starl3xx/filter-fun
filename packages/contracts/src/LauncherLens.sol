// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IFilterLauncher} from "./interfaces/IFilterLauncher.sol";
import {LaunchEscrow} from "./LaunchEscrow.sol";

/// @title LauncherLens
/// @notice Read-only companion deployed inline by `FilterLauncher`. Holds the convenience
///         view functions (`getLaunchSlots`, `getLaunchStatus`, `canReserve`) that the web
///         + indexer consume. Lives outside the launcher's bytecode to keep the launcher
///         under EIP-170 (24,576 B runtime); the deferred-activation refactor (Epic 1.15a)
///         pushed the launcher past the limit, and these views allocate memory + iterate
///         storage so they're the highest-leverage relocation target.
///
///         The lens is a thin shim: every method delegates to the launcher's existing
///         public storage / interface methods. Tests + the web pass through `launcher.lens()`
///         which is set once in the launcher's constructor and never rotated.
interface IFilterLauncherLensView {
    function paused() external view returns (bool);
    function currentSeasonId() external view returns (uint256);
    function phaseOf(uint256) external view returns (IFilterLauncher.Phase);
    function aborted(uint256) external view returns (bool);
    function launchEndTime(uint256) external view returns (uint256);
    function launchCount(uint256) external view returns (uint64);
    function launchEscrow() external view returns (LaunchEscrow);
    function baseLaunchCost() external view returns (uint256);
    function tokensInSeason(uint256) external view returns (address[] memory);
    function entryOf(uint256, address) external view returns (IFilterLauncher.TokenEntry memory);
    function launchInfoOf(uint256, address) external view returns (IFilterLauncher.LaunchInfo memory);
}

contract LauncherLens {
    /// @notice Launcher this lens reads from. Immutable — deployed inline by the launcher.
    IFilterLauncherLensView public immutable launcher;
    /// @notice Mirror of `FilterLauncher.MAX_LAUNCHES`. Hardcoded so the lens doesn't pay a
    ///         CALL per read; the launcher's value is also `12` and is never rotated.
    uint256 public constant MAX_LAUNCHES = 12;

    constructor(IFilterLauncherLensView launcher_) {
        launcher = launcher_;
    }

    /// @notice Cost of slot `slotIndex` in wei: `BASE * (1 + (slotIndex / MAX_LAUNCHES)^2)`.
    function launchCost(uint256 slotIndex) public view returns (uint256) {
        uint256 m = MAX_LAUNCHES;
        return (launcher.baseLaunchCost() * (m * m + slotIndex * slotIndex)) / (m * m);
    }

    /// @notice Spec §46 cut helper: with `n` reservations active, the bottom 50% (rounded
    ///         DOWN) get cut, leaving the top ⌈n/2⌉ as survivors. Symmetric with the indexer
    ///         + frontend so all three sides agree on cut size at any N.
    function expectedSurvivorCount(uint256 reservationCount_) external pure returns (uint256) {
        return reservationCount_ - (reservationCount_ / 2);
    }

    function reservationCount(uint256 seasonId) external view returns (uint256) {
        return launcher.launchEscrow().reservationCountOf(seasonId);
    }

    function canReserve() external view returns (bool) {
        if (launcher.paused()) return false;
        uint256 sid = launcher.currentSeasonId();
        if (launcher.phaseOf(sid) != IFilterLauncher.Phase.Launch) return false;
        if (launcher.aborted(sid)) return false;
        if (block.timestamp >= launcher.launchEndTime(sid)) return false;
        if (launcher.launchEscrow().reservationCountOf(sid) >= MAX_LAUNCHES) return false;
        return true;
    }

    function getLaunchStatus(uint256 seasonId) external view returns (IFilterLauncher.LaunchStatus memory s) {
        s.launchCount = launcher.launchCount(seasonId);
        s.maxLaunches = MAX_LAUNCHES;
        uint256 endT = launcher.launchEndTime(seasonId);
        s.timeRemaining = block.timestamp >= endT ? 0 : endT - block.timestamp;
        uint256 res = launcher.launchEscrow().reservationCountOf(seasonId);
        s.nextLaunchCost = res < MAX_LAUNCHES ? launchCost(res) : 0;
    }

    /// @notice Returns parallel arrays describing every public-launch slot deployed in
    ///         `seasonId`. Pre-activation this returns empty arrays since no public token
    ///         has been deployed yet.
    function getLaunchSlots(uint256 seasonId)
        external
        view
        returns (address[] memory tokens, uint64[] memory slotIndexes, address[] memory creators)
    {
        address[] memory all = launcher.tokensInSeason(seasonId);
        uint256 n = all.length;
        uint256 publicCount;
        IFilterLauncher.TokenEntry[] memory entries = new IFilterLauncher.TokenEntry[](n);
        for (uint256 i = 0; i < n; ++i) {
            entries[i] = launcher.entryOf(seasonId, all[i]);
            if (!entries[i].isProtocolLaunched) ++publicCount;
        }
        tokens = new address[](publicCount);
        slotIndexes = new uint64[](publicCount);
        creators = new address[](publicCount);
        uint256 j;
        for (uint256 i = 0; i < n; ++i) {
            if (entries[i].isProtocolLaunched) continue;
            tokens[j] = all[i];
            slotIndexes[j] = launcher.launchInfoOf(seasonId, all[i]).slotIndex;
            creators[j] = entries[i].creator;
            ++j;
        }
    }
}
