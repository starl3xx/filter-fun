// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
    function vaultOf(uint256 seasonId) external view returns (address);
}

/// @notice Stand-in for `FilterLauncher` that exposes the lookups `SeasonVault` and
///         `POLVault` query during their auth checks.
contract MockLauncherView is ILauncherView {
    mapping(uint256 => mapping(address => address)) internal _locker;
    mapping(uint256 => address) internal _vault;

    function setLocker(uint256 seasonId, address token, address locker) external {
        _locker[seasonId][token] = locker;
    }

    function setVault(uint256 seasonId, address vault) external {
        _vault[seasonId] = vault;
    }

    function lockerOf(uint256 seasonId, address token) external view override returns (address) {
        return _locker[seasonId][token];
    }

    function vaultOf(uint256 seasonId) external view override returns (address) {
        return _vault[seasonId];
    }
}
