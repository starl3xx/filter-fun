// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {MaliciousERC20, IMaliciousReceiverHook} from "../invariant/MaliciousReceiver.sol";
import {MiniMerkle} from "../utils/MiniMerkle.sol";

/// @title BonusDistributorReentrancyTest -- Audit Finding C-1
/// @notice The Phase-1 audit (PR #52, `audit/2026-05-PHASE-1-AUDIT/contracts.md` Critical #1)
///         flagged that BonusDistributor's state-mutating functions lacked the `nonReentrant`
///         modifier required by spec §42.2.5 ("every state-mutating function in the settlement
///         pipeline is `nonReentrant`"). The contract was *incidentally* safe through correct
///         CEI ordering on `claim()`, but `fundBonus()` had a genuine re-entry path that let an
///         attacker (acting as both "vault" caller and WETH transfer-hook receiver) corrupt
///         accounting for a different seasonId mid-call. This suite reproduces both vectors and
///         asserts the spec-required guard is the layer that fires.
///
///         Test outcome contract:
///           - Pre-fix: `test_AuditC1_FundBonus...` FAILS (inner re-entry succeeds → state
///             corruption); `test_AuditC1_Claim...` FAILS (re-entry blocked but by the wrong
///             layer -- `AlreadyClaimed` instead of `ReentrancyGuardReentrantCall`).
///           - Post-fix: both tests PASS -- guard fires first, accounting stays consistent.
contract BonusDistributorReentrancyTest is Test {
    MaliciousERC20 weth;
    BonusDistributor bonus;

    address constant LAUNCHER = address(0xA);
    address constant ORACLE = address(0xB);
    address constant VAULT = address(0xC);
    address constant WINNER_TOKEN = address(0xD);
    address constant NORMAL_USER = address(0xE);

    uint256 constant SEASON_ID = 1;
    uint256 constant ATTACKER_BONUS = 0.4 ether;
    uint256 constant NORMAL_BONUS = 0.6 ether;
    uint256 constant TOTAL_BONUS = ATTACKER_BONUS + NORMAL_BONUS;

    function setUp() public {
        weth = new MaliciousERC20("Wrapped Ether", "WETH");
        bonus = new BonusDistributor(LAUNCHER, address(weth), ORACLE);

        weth.mint(VAULT, TOTAL_BONUS);
        vm.prank(VAULT);
        weth.approve(address(bonus), TOTAL_BONUS);
    }

    // ============================================================ claim() re-entry

    /// @notice Audit C-1: claim() must be guarded by `nonReentrant` per spec §42.2.5.
    ///         A malicious WETH transfer hook re-enters `claim()` mid-payout. Pre-fix the
    ///         inner call reverts via `AlreadyClaimed` (CEI saved us); post-fix it must revert
    ///         via `ReentrancyGuardReentrantCall` -- the spec-required defense layer.
    function test_AuditC1_ClaimReentrancyBlockedByGuard() public {
        ClaimReentrant attacker = new ClaimReentrant();
        weth.setHook(address(attacker));

        // Fund + post root with attacker as one of two eligible holders.
        vm.prank(VAULT);
        bonus.fundBonus(SEASON_ID, WINNER_TOKEN, block.timestamp + 14 days, TOTAL_BONUS);

        bytes32 leafA = keccak256(abi.encodePacked(address(attacker), ATTACKER_BONUS));
        bytes32 leafN = keccak256(abi.encodePacked(NORMAL_USER, NORMAL_BONUS));
        bytes32 root = MiniMerkle.rootOfTwo(leafA, leafN);

        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(ORACLE);
        bonus.postRoot(SEASON_ID, root);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafN;

        attacker.arm(bonus, SEASON_ID, ATTACKER_BONUS, proof);

        vm.prank(address(attacker));
        bonus.claim(SEASON_ID, ATTACKER_BONUS, proof);

        assertTrue(attacker.reentryFired(), "attack surface did not fire -- test setup broken");
        assertFalse(attacker.reentrySucceeded(), "REENTRY SUCCEEDED -- fund-loss path is live");
        assertEq(
            attacker.reentryRevertSelector(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentry blocked, but NOT by ReentrancyGuard -- spec 42.2.5 defense-in-depth missing"
        );
        assertTrue(bonus.claimed(SEASON_ID, address(attacker)), "outer claim did not complete");
        assertEq(weth.balanceOf(address(attacker)), ATTACKER_BONUS, "attacker did not receive entitled bonus");
    }

    // ============================================================ fundBonus() re-entry

    /// @notice Audit C-1: fundBonus() must be guarded by `nonReentrant` per spec §42.2.5.
    ///         The attacker acts as both the "vault" caller AND the WETH transfer-hook target --
    ///         during the in-progress `safeTransferFrom`, the hook fires and re-enters
    ///         `fundBonus` for a DIFFERENT seasonId. Pre-fix this succeeds (different
    ///         seasonId → AlreadyFunded gate doesn't trip → arbitrary accounting corruption).
    ///         Post-fix the re-entry reverts via the guard.
    function test_AuditC1_FundBonusReentrancyBlockedByGuard() public {
        FundReentrant attacker = new FundReentrant();
        weth.setHook(address(attacker));

        weth.mint(address(attacker), TOTAL_BONUS);
        vm.prank(address(attacker));
        weth.approve(address(bonus), TOTAL_BONUS);

        // Stage the inner call: re-enter into a DIFFERENT seasonId so AlreadyFunded does not
        // gate the inner attempt. With the guard missing, the inner call succeeds and the
        // attacker has corrupted accounting for a season they don't own.
        attacker.arm(
            bonus,
            abi.encodeWithSelector(
                bonus.fundBonus.selector, uint256(2), WINNER_TOKEN, block.timestamp + 14 days, uint256(1)
            )
        );

        vm.prank(address(attacker));
        bonus.fundBonus(SEASON_ID, WINNER_TOKEN, block.timestamp + 14 days, TOTAL_BONUS);

        assertTrue(attacker.reentryFired(), "fundBonus attack surface did not fire");
        assertFalse(attacker.reentrySucceeded(), "fundBonus REENTRY SUCCEEDED -- accounting corruption path is live");
        assertEq(
            attacker.reentryRevertSelector(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "fundBonus reentry blocked, but NOT by ReentrancyGuard -- spec 42.2.5 defense missing"
        );

        // Defense: the corrupted seasonId 2 must NOT have been funded.
        BonusDistributor.SeasonBonus memory s2 = bonus.bonusOf(2);
        assertEq(s2.vault, address(0), "seasonId 2 was corrupted -- accounting drift");
        assertEq(s2.reserve, 0, "seasonId 2 reserve was corrupted");
    }
}

/// @notice Test-local re-entrant claimant. Hook captures the inner call's revert selector so
///         the test can assert which defense layer fired (spec §42.2.5 demands the guard, not
///         CEI's `AlreadyClaimed` fallback).
contract ClaimReentrant is IMaliciousReceiverHook {
    BonusDistributor public bonus;
    uint256 public seasonId;
    uint256 public amount;
    bytes32[] internal _proof;

    bool public reentryFired;
    bool public reentrySucceeded;
    bytes4 public reentryRevertSelector;

    function arm(BonusDistributor bonus_, uint256 seasonId_, uint256 amount_, bytes32[] memory proof_) external {
        bonus = bonus_;
        seasonId = seasonId_;
        amount = amount_;
        delete _proof;
        for (uint256 i = 0; i < proof_.length; ++i) _proof.push(proof_[i]);
    }

    function onTokenHook() external override {
        if (address(bonus) == address(0)) return;
        reentryFired = true;

        BonusDistributor target = bonus;
        bonus = BonusDistributor(address(0)); // disarm before the inner call

        try target.claim(seasonId, amount, _proof) {
            reentrySucceeded = true;
        } catch (bytes memory reason) {
            reentryRevertSelector = _selectorOf(reason);
        }
    }

    function _selectorOf(bytes memory reason) internal pure returns (bytes4 s) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            s := mload(add(reason, 32))
        }
    }
}

/// @notice Test-local re-entrant funder for the second vector -- the attacker is BOTH the
///         calling "vault" AND the WETH transfer-hook target.
contract FundReentrant is IMaliciousReceiverHook {
    BonusDistributor public bonus;
    bytes public innerCall;

    bool public reentryFired;
    bool public reentrySucceeded;
    bytes4 public reentryRevertSelector;

    function arm(BonusDistributor bonus_, bytes calldata innerCall_) external {
        bonus = bonus_;
        innerCall = innerCall_;
    }

    function onTokenHook() external override {
        if (address(bonus) == address(0)) return;
        reentryFired = true;

        bytes memory call = innerCall;
        BonusDistributor target = bonus;
        bonus = BonusDistributor(address(0));

        (bool ok, bytes memory reason) = address(target).call(call);
        if (ok) {
            reentrySucceeded = true;
        } else {
            // Use a memory-local then a normal Solidity storage assignment so the compiler
            // handles the packed-slot offset (these three vars share slot 2). A raw
            // `sstore(reentryRevertSelector.slot, ...)` would clobber `reentryFired` and
            // `reentrySucceeded` which sit at offsets 0 and 1 of the same slot.
            bytes4 sel;
            if (reason.length >= 4) {
                assembly {
                    sel := mload(add(reason, 32))
                }
            }
            reentryRevertSelector = sel;
        }
    }
}
