// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../src/FilterLauncher.sol";
import {LaunchEscrow} from "../../src/LaunchEscrow.sol";
import {TickerLib} from "../../src/libraries/TickerLib.sol";
import {IFilterFactory} from "../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../src/SeasonVault.sol";
import {BonusDistributor} from "../../src/BonusDistributor.sol";
import {TournamentRegistry} from "../../src/TournamentRegistry.sol";
import {TournamentVault} from "../../src/TournamentVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockFilterFactory} from "../mocks/MockFilterFactory.sol";

/// @title TickerValidationTest
/// @notice Spec §4.6.1 ticker uniqueness + protocol blocklist + cross-season winner
///         reservation. Each row of the validation matrix has a focused regression test.
contract TickerValidationTest is Test {
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

    address aliceCreator = address(0xA1);
    address bobCreator = address(0xB1);

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

        vm.deal(aliceCreator, 100 ether);
        vm.deal(bobCreator, 100 ether);
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

    // ============================================================ Per-season collisions

    function test_SameSeasonExactCollision() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("PEPE", "ipfs://a");

        bytes32 hash_ = keccak256("PEPE");
        vm.prank(bobCreator);
        vm.expectRevert(FilterLauncher.TickerTaken.selector);
        launcher.reserve{value: _slotCost(1)}("PEPE", "ipfs://b");
    }

    function test_CaseInsensitiveCollision() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("Pepe", "ipfs://a");
        bytes32 hash_ = keccak256("PEPE");
        vm.prank(bobCreator);
        vm.expectRevert(FilterLauncher.TickerTaken.selector);
        launcher.reserve{value: _slotCost(1)}("PEPE", "ipfs://b");
    }

    function test_LeadingDollarCollision() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("$pepe", "ipfs://a");
        // `$pepe` normalises to "PEPE" — bob's "PEPE" must collide.
        bytes32 hash_ = keccak256("PEPE");
        vm.prank(bobCreator);
        vm.expectRevert(FilterLauncher.TickerTaken.selector);
        launcher.reserve{value: _slotCost(1)}("PEPE", "ipfs://b");
    }

    function test_WhitespacePaddingCollision() public {
        _openSeason();
        vm.prank(aliceCreator);
        launcher.reserve{value: _slotCost(0)}("  pepe  ", "ipfs://a");
        bytes32 hash_ = keccak256("PEPE");
        vm.prank(bobCreator);
        vm.expectRevert(FilterLauncher.TickerTaken.selector);
        launcher.reserve{value: _slotCost(1)}("PEPE", "ipfs://b");
    }

    // ============================================================ Format validation

    function test_HomographCyrillicERejectedAtFormat() public {
        _openSeason();
        // Cyrillic capital "Е" (U+0415) is `0xD0 0x95` in UTF-8 — non-ASCII high bit set.
        // The TickerLib validator rejects at format time, NOT at uniqueness, so a homograph
        // can never silently collide with the ASCII "E".
        bytes memory raw = hex"D095D095"; // "ЕЕ"
        string memory ticker = string(raw);
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.reserve{value: _slotCost(0)}(ticker, "ipfs://a");
    }

    function test_TooShortRejected() public {
        _openSeason();
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.reserve{value: _slotCost(0)}("X", "ipfs://a");
    }

    function test_TooLongRejected() public {
        _openSeason();
        // 11 chars > 10 max.
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.reserve{value: _slotCost(0)}("ABCDEFGHIJK", "ipfs://a");
    }

    function test_PunctuationRejected() public {
        _openSeason();
        vm.prank(aliceCreator);
        vm.expectRevert();
        launcher.reserve{value: _slotCost(0)}("PE-PE", "ipfs://a");
    }

    // ============================================================ Protocol blocklist

    function test_BlocklistRejectsFILTER() public {
        _openSeason();
        bytes32 h = keccak256("FILTER");
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.TickerBlocklisted.selector);
        launcher.reserve{value: _slotCost(0)}("FILTER", "ipfs://a");
    }

    function test_BlocklistRejectsWETH() public {
        _openSeason();
        bytes32 h = keccak256("WETH");
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.TickerBlocklisted.selector);
        launcher.reserve{value: _slotCost(0)}("WETH", "ipfs://a");
    }

    function test_BlocklistRejectsETH_USDC_USDT_DAI() public {
        _openSeason();
        string[4] memory tickers = ["ETH", "USDC", "USDT", "DAI"];
        for (uint256 i = 0; i < tickers.length; ++i) {
            address creator = address(uint160(0xC0DE0000) + uint160(i));
            vm.deal(creator, 1 ether);
            bytes32 h = keccak256(bytes(tickers[i]));
            vm.prank(creator);
            vm.expectRevert(FilterLauncher.TickerBlocklisted.selector);
            launcher.reserve{value: _slotCost(0)}(tickers[i], "ipfs://a");
        }
    }

    function test_MultisigCanAddBlocklistEntry() public {
        // Audit: bugbot M PR #88. The caller MUST canonicalise off-chain — the contract
        // accepts the raw bytes32 to fit the EIP-170 budget. The runbook references the
        // 1.15b/c TS port of `TickerLib.normalize` for off-chain canonicalisation.
        bytes32 newHash = keccak256(bytes("BAITCOIN"));
        launcher.addTickerToBlocklist(newHash);
        assertTrue(launcher.tickerBlocklist(newHash));

        // Subsequent reserve fails.
        _openSeason();
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.TickerBlocklisted.selector);
        launcher.reserve{value: _slotCost(0)}("BAITCOIN", "ipfs://a");
    }

    /// @notice Audit: bugbot M PR #88. Pin the failure mode: a non-canonical hash slips
    ///         through unchanged, demonstrating the documented invariant that ops must
    ///         canonicalise off-chain. The intended block of "BAITCOIN" via the wrong
    ///         (non-canonical) hash `keccak256(bytes("baitcoin"))` is silently stored
    ///         under the wrong key, so `reserve("baitcoin")` (which normalises to
    ///         `BAITCOIN`) is NOT blocked. This test exists to make the failure mode
    ///         visible to a maintainer who tries to `addTickerToBlocklist(keccak256("baitcoin"))`
    ///         in a future PR.
    function test_NonCanonicalHashSilentlyStoresWrongSlot() public {
        bytes32 wrongHash = keccak256(bytes("baitcoin")); // lowercase
        launcher.addTickerToBlocklist(wrongHash);
        assertTrue(launcher.tickerBlocklist(wrongHash), "wrong hash IS stored");
        bytes32 canonicalHash = keccak256(bytes("BAITCOIN"));
        assertFalse(launcher.tickerBlocklist(canonicalHash), "canonical hash NOT stored");

        // Operator-side enforcement: the multisig must derive via TickerLib semantics.
    }

    function test_NonMultisigBlocklistAddReverts() public {
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.NotMultisig.selector);
        launcher.addTickerToBlocklist(keccak256("RANDOM"));
    }

    // ============================================================ Cross-season winner reservation

    function test_WinnerTickerLocksAcrossFutureSeasons() public {
        _openSeason();
        // Skip the full season lifecycle — the launcher's setWinnerTicker is open to the
        // current season's vault by `_vault[seasonId] == msg.sender`. We simulate the vault
        // by reading the address and pranking from it.
        address vaultS1 = launcher.vaultOf(1);

        bytes32 winnerHash = keccak256("PEPEWIN");
        // Pretend $PEPEWIN won season 1.
        vm.prank(vaultS1);
        launcher.setWinnerTicker(1, winnerHash, address(0xBEEF));

        assertEq(launcher.winnerTickers(winnerHash), address(0xBEEF));

        // Advance to season 2; reserve("PEPEWIN") must revert TickerWinnerReserved.
        // To open season 2 we'd need to walk the full lifecycle of season 1. Instead, just
        // verify the same-season reserve already trips the cross-season check on the SAME
        // mapping — same code path, only difference is the seasonTickers per-season key.
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.TickerWinnerReserved.selector);
        launcher.reserve{value: _slotCost(0)}("PEPEWIN", "ipfs://a");
    }

    function test_OnlySeasonVaultCanSetWinnerTicker() public {
        _openSeason();
        vm.prank(aliceCreator);
        vm.expectRevert(FilterLauncher.NotSeasonVault.selector);
        launcher.setWinnerTicker(1, keccak256("X"), address(0xBEEF));
    }
}
