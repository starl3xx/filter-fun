// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FilterLauncher} from "../../../src/FilterLauncher.sol";
import {LaunchEscrow} from "../../../src/LaunchEscrow.sol";
import {IFilterFactory} from "../../../src/interfaces/IFilterFactory.sol";
import {IBonusFunding, IPOLManager} from "../../../src/SeasonVault.sol";
import {BonusDistributor} from "../../../src/BonusDistributor.sol";

import {MockWETH} from "../../mocks/MockWETH.sol";
import {MockFilterFactory} from "../../mocks/MockFilterFactory.sol";

/// @title DeferredActivationHandler
/// @notice Bounded-action fuzz handler for the spec §46 reservation flow. Exposes a small
///         set of selectors that mutate launcher + escrow state across a single season
///         lifecycle; the invariant test reads ghost state + on-chain state to assert the
///         three §46 properties:
///           (a) past h48 every reservation is in a terminal lifecycle state (released or
///               refunded), never orphaned in escrow
///           (b) activation is atomic — the 4th reservation either lands the cohort fully
///               (4 deploys + SeasonActivated) or reverts the whole tx
///           (c) per-season tickerHash uniqueness — `seasonTickers[seasonId]` is injective
///
///         Cohort: 12 distinct creator EOAs, 16 candidate tickers, 1 season. Bounded so the
///         fuzzer can densely cover (action × actor × ticker) within `runs × depth`.
contract DeferredActivationHandler is Test {
    uint256 public constant SEASON_ID = 1;
    uint256 public constant CREATOR_COUNT = 16;
    uint256 public constant TICKER_COUNT = 24;

    FilterLauncher public launcher;
    LaunchEscrow public escrow;
    MockFilterFactory public factory;
    BonusDistributor public bonus;
    MockWETH public weth;

    address public oracle;
    address public treasury;
    address public mechanics;

    address[CREATOR_COUNT] public creators;
    string[TICKER_COUNT] public tickerPool;

    /// @dev Ghost: every creator that has successfully called `reserve` in this season,
    ///      ordered by reservation. The invariant test iterates over this list to verify
    ///      every entry's terminal state post-h48.
    address[] public ghostReservers;
    /// @dev Ghost: every tickerHash that has successfully reserved a slot. The uniqueness
    ///      invariant asserts this list has no duplicates AND `seasonTickers[seasonId][hash]`
    ///      is the same creator that reserved it.
    bytes32[] public ghostTickerHashes;
    mapping(bytes32 => address) public ghostTickerToCreator;
    /// @dev Ghost: pre-state on the activation tx so the invariant can detect a partial
    ///      activation (impossible — but if it ever happens, this catches it).
    bool public ghostActivationStarted;
    bool public ghostActivationCompleted;
    uint256 public ghostLaunchCountAtActivationStart;

    constructor() {
        weth = new MockWETH();
        oracle = address(0xCAFE);
        treasury = address(0xD000);
        mechanics = address(0xE000);

        bonus = new BonusDistributor(address(0), address(weth), oracle);
        launcher = new FilterLauncher(
            address(this), oracle, treasury, mechanics, IBonusFunding(address(bonus)), address(weth)
        );
        launcher.setPolManager(IPOLManager(address(0xF000)));
        factory = new MockFilterFactory(address(launcher), address(weth));
        launcher.setFactory(IFilterFactory(address(factory)));
        escrow = launcher.launchEscrow();

        // Open season 1 once at construction; the fuzzer drives reservations + abort.
        vm.prank(oracle);
        launcher.startSeason();

        for (uint160 i = 0; i < uint160(CREATOR_COUNT); ++i) {
            address c = address(uint160(0xC1000000) + i);
            creators[i] = c;
            vm.deal(c, 1000 ether);
        }

        // 24 candidate tickers — a mix of letters and digits, none in the protocol blocklist.
        tickerPool[0] = "AAAA";
        tickerPool[1] = "BBBB";
        tickerPool[2] = "CCCC";
        tickerPool[3] = "DDDD";
        tickerPool[4] = "EEEE";
        tickerPool[5] = "FFFF";
        tickerPool[6] = "GGGG";
        tickerPool[7] = "HHHH";
        tickerPool[8] = "IIII";
        tickerPool[9] = "JJJJ";
        tickerPool[10] = "KKKK";
        tickerPool[11] = "LLLL";
        tickerPool[12] = "MMMM";
        tickerPool[13] = "NNNN";
        tickerPool[14] = "OOOO";
        tickerPool[15] = "PPPP";
        tickerPool[16] = "QQQQ";
        tickerPool[17] = "RRRR";
        tickerPool[18] = "SSSS";
        tickerPool[19] = "TTTT";
        tickerPool[20] = "UUUU";
        tickerPool[21] = "VVVV";
        tickerPool[22] = "WWWW";
        tickerPool[23] = "XXXX";
    }

    receive() external payable {}

    // ============================================================ Selectors

    /// @notice Reserve a slot for a fuzzer-chosen creator with a fuzzer-chosen ticker. Reverts
    ///         (silently to the fuzzer) on every wrong-state path: already reserved, already
    ///         taken, slots exhausted, window closed, etc. Successful calls update the ghost
    ///         registers used by the invariants.
    function fuzz_reserve(uint256 creatorIdx, uint256 tickerIdx, uint256 valueWei) external {
        creatorIdx = bound(creatorIdx, 0, CREATOR_COUNT - 1);
        tickerIdx = bound(tickerIdx, 0, TICKER_COUNT - 1);
        // Ensure caller has enough ETH for any plausible slot cost (max ~0.1 ether at slot 11).
        valueWei = bound(valueWei, 0, 1 ether);

        address creator = creators[creatorIdx];
        string memory ticker = tickerPool[tickerIdx];
        bytes32 tickerHash = keccak256(bytes(ticker));

        // Detect an activation attempt: when reservationCount == 3 entering reserve, if the
        // call succeeds it crosses the threshold and triggers _activate. We snapshot launcher
        // state right before so a post-state inconsistency is detectable.
        bool isActivationCall =
            launcher.lens().reservationCount(SEASON_ID) == 3 && !launcher.activated(SEASON_ID);

        if (isActivationCall) {
            ghostActivationStarted = true;
            ghostLaunchCountAtActivationStart = launcher.launchCount(SEASON_ID);
        }

        try this.reserveExternal(creator, valueWei, ticker) {
            // Successful reservation. Record ghosts.
            ghostReservers.push(creator);
            ghostTickerHashes.push(tickerHash);
            ghostTickerToCreator[tickerHash] = creator;
            if (isActivationCall) {
                ghostActivationCompleted = true;
            }
        } catch {
            // Wrong-state revert (already reserved / taken / slots exhausted / etc.) — fine,
            // the fuzzer will pick something else.
        }
    }

    /// @dev External wrapper so we can `try`/`catch` a `vm.prank`-pranked call. Foundry's
    ///      try/catch only works on external calls — pranking inline within a `try` block
    ///      has been known to silently bypass the prank.
    function reserveExternal(address creator, uint256 valueWei, string memory ticker) external {
        require(msg.sender == address(this), "internal-only");
        vm.prank(creator);
        launcher.reserve{value: valueWei}(ticker, "ipfs://m");
    }

    /// @notice Warp past h48 and call abortSeason if the season is sparse. Lets the fuzzer
    ///         drive the abort path so the orphaned-escrow invariant has data to assert on.
    function fuzz_warpAndAbort(uint256 warpSeconds) external {
        warpSeconds = bound(warpSeconds, 48 hours, 60 hours);
        vm.warp(block.timestamp + warpSeconds);

        if (launcher.activated(SEASON_ID) || launcher.aborted(SEASON_ID)) return;
        try this.abortExternal() {} catch {}
    }

    function abortExternal() external {
        require(msg.sender == address(this), "internal-only");
        vm.prank(oracle);
        launcher.abortSeason(SEASON_ID);
    }

    // ============================================================ Ghost views

    function ghostReserverCount() external view returns (uint256) {
        return ghostReservers.length;
    }

    function ghostTickerCount() external view returns (uint256) {
        return ghostTickerHashes.length;
    }
}
