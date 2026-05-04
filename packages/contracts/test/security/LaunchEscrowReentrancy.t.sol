// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault} from "../../src/TournamentVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title MaliciousRefundReceiver
/// @notice Receiver that re-enters `LaunchEscrow.refundAll` while inside its own ETH receive
///         hook, exercising the worst-case race for the abort path. The launcher gates
///         `refundAll` behind oracle auth and a non-reentrant modifier, so the reentry
///         attempt MUST fail without disturbing the rest of the sweep.
contract MaliciousRefundReceiver {
    LaunchEscrow public immutable escrow;
    address public immutable launcher;
    uint256 public immutable seasonId;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(LaunchEscrow escrow_, address launcher_, uint256 seasonId_) {
        escrow = escrow_;
        launcher = launcher_;
        seasonId = seasonId_;
    }

    /// @dev Forwards a `reserve` call to the launcher with the supplied ETH so the test can
    ///      seed an escrow record for THIS contract (whose receive hook re-enters).
    function reserveVia(string calldata ticker, string calldata metadataURI) external payable {
        FilterLauncher(payable(launcher)).reserve{value: msg.value}(ticker, metadataURI);
    }

    receive() external payable {
        // Try to re-enter the abort sweep while we're inside one. nonReentrant on
        // LaunchEscrow.refundAll must trip the inner call.
        if (!reentryAttempted) {
            reentryAttempted = true;
            (bool ok,) =
                address(escrow).call(abi.encodeWithSelector(LaunchEscrow.refundAll.selector, seasonId));
            reentrySucceeded = ok;
        }
    }
}

/// @title MaliciousReleaseReceiver
/// @notice Same idea, but re-enters `releaseToDeploy` from inside the launcher's deploy-path
///         ETH receive. Covers the activation-side reentry surface.
contract MaliciousReleaseReceiver {
    LaunchEscrow public immutable escrow;
    address public immutable launcher;
    uint256 public immutable seasonId;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(LaunchEscrow escrow_, address launcher_, uint256 seasonId_) {
        escrow = escrow_;
        launcher = launcher_;
        seasonId = seasonId_;
    }

    function reserveVia(string calldata ticker, string calldata metadataURI) external payable {
        FilterLauncher(payable(launcher)).reserve{value: msg.value}(ticker, metadataURI);
    }

    /// @dev Receives the refund-on-excess path; tries to re-enter `releaseToDeploy`. The
    ///      launcher's own `nonReentrant` (on `reserve`) plus the escrow's `nonReentrant`
    ///      (on `releaseToDeploy`) both stand in the way.
    receive() external payable {
        if (!reentryAttempted) {
            reentryAttempted = true;
            (bool ok,) = address(escrow)
                .call(abi.encodeWithSelector(LaunchEscrow.releaseToDeploy.selector, seasonId, address(this)));
            reentrySucceeded = ok;
        }
    }
}

/// @title LaunchEscrowReentrancyTest
/// @notice Spec §46 reentrancy regression suite for `LaunchEscrow`. Mirrors the pattern of
///         `BonusDistributorReentrancy.t.sol` (PR #60): build a malicious receiver, drive it
///         through a real launcher flow, assert the reentry surface FIRES (so the test has
///         teeth — a regression that breaks the receive hook would otherwise pass vacuously)
///         AND is BLOCKED by the nonReentrant modifier.
contract LaunchEscrowReentrancyTest is Test {
    FilterLauncher launcher;
    LaunchEscrow escrow;
    MockFilterFactory factory;
    BonusDistributor bonus;
    MockWETH weth;

    address owner = address(this);
    address oracle = address(0xCAFE);
    address treasury = address(0xD000);
    address mechanics = address(0xE000);
    address polManager = address(0xF000);

    receive() external payable {}

    function setUp() public {
        weth = new MockWETH();
        bonus = new BonusDistributor(address(0), address(weth), oracle);
        launcher = new FilterLauncher(
            owner, oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        launcher.setPolManager(IPOLManager(polManager));
        factory = new MockFilterFactory(address(launcher), address(weth));
        launcher.setFactory(IFilterFactory(address(factory)));
        // Tournament wire required since `startSeason` zero-checks the registry
        // (audit: bugbot M PR #88).
        launcher.setTournament(TournamentRegistry(address(0xDEAD)), TournamentVault(payable(address(0xBEEF))));
        escrow = launcher.launchEscrow();
    }

    function _slotCost(uint64 slotIndex) internal pure returns (uint256) {
        uint256 base = 0.05 ether;
        uint256 m = 12;
        uint256 s = uint256(slotIndex);
        return (base * (m * m + s * s)) / (m * m);
    }

    function _openSeason() internal returns (uint256 sid) {
        vm.prank(oracle);
        sid = launcher.startSeason();
    }

    /// @notice Refund path: malicious receiver re-enters `refundAll`, hook fires, inner call
    ///         is blocked, sweep completes for the rest of the cohort.
    function test_RefundAllBlocksReentry() public {
        uint256 sid = _openSeason();
        MaliciousRefundReceiver attacker = new MaliciousRefundReceiver(escrow, address(launcher), sid);
        // Attacker contract starts at 0 — funds for the reservation come from this test
        // contract's `msg.value` passthrough through `reserveVia`. After the abort, the
        // refund routes back to the attacker's `receive` (gaining `cost`); the reentry
        // attempt inside the hook fails but the outer return succeeds.

        attacker.reserveVia{value: _slotCost(0)}("AAAA", "ipfs://a");

        address bystander = makeAddr("bystander");
        vm.deal(bystander, 10 ether);
        vm.prank(bystander);
        launcher.reserve{value: _slotCost(1)}("BBBB", "ipfs://b");

        // Close the window and abort.
        vm.warp(block.timestamp + 48 hours);
        vm.prank(oracle);
        launcher.abortSeason(sid);

        // The attacker's receive hook FIRED (so the surface is real) and the inner re-call
        // was BLOCKED (so reentry was actually prevented).
        assertTrue(attacker.reentryAttempted(), "reentry surface did not fire");
        assertFalse(attacker.reentrySucceeded(), "reentry was NOT blocked");

        // Bystander's refund landed even though the attacker's reentry attempt failed.
        assertEq(bystander.balance, 10 ether, "bystander made whole");

        // Attacker received the refund (its receive returned successfully even after the
        // inner reentry call failed) — final balance equals the slot cost it reserved.
        assertEq(address(attacker).balance, _slotCost(0), "attacker received refund");
    }

    /// @notice Release path: malicious receiver re-enters `releaseToDeploy` while the
    ///         excess-refund leg of `reserve` is paying it back. The launcher's own
    ///         nonReentrant on `reserve` is the load-bearing guard here.
    function test_ReleaseToDeployBlocksReentryViaExcessRefund() public {
        uint256 sid = _openSeason();
        MaliciousReleaseReceiver attacker = new MaliciousReleaseReceiver(escrow, address(launcher), sid);
        vm.deal(address(attacker), 10 ether);

        // Three benign reservations to set up; the 4th (attacker) crosses the activation
        // threshold and triggers the deploy path.
        for (uint160 i = 1; i <= 3; ++i) {
            address creator = address(uint160(0xBA5E0000) + i);
            vm.deal(creator, 1 ether);
            string memory ticker = string(abi.encodePacked("LR", bytes1(uint8(48 + i))));
            uint256 cost = _slotCost(uint64(i - 1));
            vm.prank(creator);
            launcher.reserve{value: cost}(ticker, "ipfs://m");
        }
        // Send extra ETH to trigger the excess-refund leg into the attacker's receive.
        attacker.reserveVia{value: _slotCost(3) + 0.01 ether}("LRX", "ipfs://x");

        assertTrue(attacker.reentryAttempted(), "reentry surface did not fire");
        assertFalse(attacker.reentrySucceeded(), "reentry was NOT blocked");
    }
}
