// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {CreatorFeeDistributor} from "../../src/CreatorFeeDistributor.sol";
import {CreatorRegistry} from "../../src/CreatorRegistry.sol";
import {MockLauncherView} from "../mocks/MockLauncherView.sol";
import {MockWETH} from "../mocks/MockWETH.sol";

/// @title OperatorAuditInvariants
/// @notice Epic 1.21 / spec §47.4 invariant: every operator-callable settlement-relevant
///         function emits a structured audit signal so the indexer can populate
///         `OperatorActionLog`.
///
///         In v1 this covers two surfaces:
///           - `CreatorFeeDistributor.disableCreatorFee` → emits `OperatorActionEmitted`
///             directly. This invariant asserts the property holds for every successful
///             call.
///           - `FilterLauncher.addTickerToBlocklist` → byte-budget excluded from emitting
///             `OperatorActionEmitted` (see the natspec on that function); the indexer
///             derives the audit row from `TickerBlocked` + tx `from`. Covered by the
///             existing FilterLauncher test surface, not this invariant.
///
///         Implemented as a deterministic property test driving N randomized
///         (token, reason) calls and asserting each lands a non-empty event with the
///         right shape. This is functionally equivalent to a fuzz invariant for a
///         per-call property — the cohort of properties this checks doesn't depend on
///         multi-call sequencing, so a deterministic loop is cheaper and avoids the
///         StdInvariant boilerplate without losing coverage.
contract OperatorAuditInvariantsTest is Test {
    CreatorFeeDistributor distributor;
    CreatorRegistry registry;
    MockWETH weth;
    MockLauncherView launcher;

    address treasury = makeAddr("treasury");
    address operator = makeAddr("operator");

    uint256 constant SEASON = 1;
    uint256 constant TRIALS = 32;

    function setUp() public {
        weth = new MockWETH();
        launcher = new MockLauncherView();
        registry = new CreatorRegistry(address(this));
        distributor = new CreatorFeeDistributor(address(launcher), address(weth), treasury, registry);
        launcher.setOwner(operator);
    }

    /// @notice inv_operator_actions_logged: every successful `disableCreatorFee` call
    ///         emits exactly one `OperatorActionEmitted` event with:
    ///           - actor == msg.sender (here: `operator`)
    ///           - action == "disableCreatorFee" (non-empty)
    ///           - params == abi.encode(token, reason) (non-empty for non-empty reason)
    ///
    ///         Driving 32 randomised (token, reason) calls + asserting on every one is
    ///         deterministic-fuzz coverage for a per-call property. A failure mode where
    ///         someone removes the emit or accidentally elides one branch surfaces here
    ///         as a missing event in the recorded logs.
    ///
    /// @dev    Named with the `test_` prefix (not `invariant_`) on purpose: Foundry's
    ///         StdInvariant runner randomises calls across every method in the test
    ///         contract between invariant invocations — including the mock's
    ///         `setOwner(...)` — which would flip the operator address mid-run and
    ///         falsify the per-call property under valid execution. The property here
    ///         is per-call, not multi-call, so a deterministic loop is the right
    ///         framing. The `_invariant` suffix preserves the conceptual link to
    ///         spec §47.4's `inv_operator_actions_logged` for grep / cross-ref.
    function test_operatorActionsLogged_invariant() public {
        // Drive a deterministic suite of disableCreatorFee calls and assert the audit
        // event fires on each one. We can't use Foundry's StdInvariant `targetSelector`
        // here without a handler — but the property is per-call, not multi-call, so a
        // straight loop covers it more directly.
        for (uint256 i = 0; i < TRIALS; i++) {
            address token = address(uint160(uint256(keccak256(abi.encode("op_audit_token", i)))));
            address creator = address(uint160(uint256(keccak256(abi.encode("op_audit_creator", i)))));
            string memory reason = string(abi.encodePacked("reason-", _toString(i)));

            registry.register(token, creator);
            vm.prank(address(launcher));
            distributor.registerToken(token, SEASON);

            vm.recordLogs();
            vm.prank(operator);
            distributor.disableCreatorFee(token, reason);
            Vm.Log[] memory logs = vm.getRecordedLogs();

            // Find the OperatorActionEmitted event in the recorded logs.
            bytes32 sig = keccak256(bytes("OperatorActionEmitted(address,string,bytes)"));
            bool found;
            for (uint256 j = 0; j < logs.length; j++) {
                if (logs[j].topics.length > 0 && logs[j].topics[0] == sig) {
                    // topic[1] is `actor` (indexed). Decode and assert.
                    address actor = address(uint160(uint256(logs[j].topics[1])));
                    assertEq(actor, operator, "audit event actor mismatch");

                    // Non-indexed: (string action, bytes params). Decode the data blob.
                    (string memory action, bytes memory params) = abi.decode(
                        logs[j].data,
                        (string, bytes)
                    );
                    assertEq(action, "disableCreatorFee", "audit event action mismatch");
                    assertGt(bytes(action).length, 0, "audit event action empty");
                    assertGt(params.length, 0, "audit event params empty");

                    // Decoded params should round-trip back to (token, reason).
                    (address pt, string memory pr) = abi.decode(params, (address, string));
                    assertEq(pt, token, "audit event params token mismatch");
                    assertEq(pr, reason, "audit event params reason mismatch");

                    found = true;
                    break;
                }
            }
            assertTrue(found, "OperatorActionEmitted not in logs");
        }
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 temp = v;
        uint256 digits;
        while (temp != 0) { ++digits; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (v != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(v % 10)));
            v /= 10;
        }
        return string(buffer);
    }
}
