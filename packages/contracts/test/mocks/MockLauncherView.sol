// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
    function vaultOf(uint256 seasonId) external view returns (address);
    function oracle() external view returns (address);
}

/// @notice Stand-in for `FilterLauncher` that exposes the lookups `SeasonVault`, `POLVault`,
///         and `TournamentRegistry` query during their auth checks. `oracle()` is mutable
///         here so tests can prove the registry's onlyOracle modifier follows rotations.
contract MockLauncherView is ILauncherView {
    mapping(uint256 => mapping(address => address)) internal _locker;
    mapping(uint256 => address) internal _vault;
    address internal _oracle;

    function setLocker(uint256 seasonId, address token, address locker) external {
        _locker[seasonId][token] = locker;
    }

    function setVault(uint256 seasonId, address vault) external {
        _vault[seasonId] = vault;
    }

    function setOracle(address oracle_) external {
        _oracle = oracle_;
    }

    function lockerOf(uint256 seasonId, address token) external view override returns (address) {
        return _locker[seasonId][token];
    }

    function vaultOf(uint256 seasonId) external view override returns (address) {
        return _vault[seasonId];
    }

    function oracle() external view override returns (address) {
        return _oracle;
    }
}
