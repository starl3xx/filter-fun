// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICreatorFeeDistributor} from "../../src/SeasonVault.sol";

/// @notice Empty stand-in for the creator-fee distributor. Per spec §10.3 (Epic 1.16) the
///         distributor no longer exposes a `markFiltered` hook — creator-fee accrual is
///         perpetual and pool lifecycle implicitly stops it. The interface is kept on
///         SeasonVault as an empty marker so existing wiring + Deploy script signatures don't
///         need a parallel-rev refactor.
contract MockCreatorFeeDistributor is ICreatorFeeDistributor {}
