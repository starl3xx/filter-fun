// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
}

/// @notice Stand-in for `FilterLauncher` that just exposes the locker mapping `SeasonVault`
///         queries during `liquidate` and `finalize`.
contract MockLauncherView is ILauncherView {
    mapping(uint256 => mapping(address => address)) internal _locker;

    function setLocker(uint256 seasonId, address token, address locker) external {
        _locker[seasonId][token] = locker;
    }

    function lockerOf(uint256 seasonId, address token) external view override returns (address) {
        return _locker[seasonId][token];
    }
}
