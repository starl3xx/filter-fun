// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILpLocker} from "./interfaces/ILpLocker.sol";
import {SeasonPOLReserve} from "./SeasonPOLReserve.sol";

interface IBonusFunding {
    function fundBonus(uint256 seasonId, address winnerToken, uint256 unlockTime, uint256 amount) external;
}

interface IPOLManager {
    function deployPOL(uint256 seasonId, address winner, uint256 wethAmount, uint256 minTokensFromSwap)
        external
        returns (uint256 wethUsed, uint256 tokensUsed, uint128 liquidity);
}

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
    /// @notice Live oracle address. SeasonVault's `onlyOracle` modifier reads through this
    ///         on every call so an oracle rotation on the launcher takes effect immediately
    ///         on every existing per-season vault — no per-vault setter, no rotation script.
    ///         Audit H-2 (Phase 1, 2026-05-01, spec §42.2.6): a stored oracle on each vault
    ///         left vaults from prior seasons honouring the old oracle indefinitely after
    ///         `FilterLauncher.setOracle` rotated.
    function oracle() external view returns (address);
}

/// @notice Retained as an empty interface for backwards-compatible imports + Deploy script
///         wiring. Per spec §10.3 (locked 2026-05-02) the distributor no longer exposes a
///         `markFiltered` hook — creator-fee accrual is perpetual and pool lifecycle (LP
///         unwind) implicitly stops it. The SeasonVault no longer calls into the distributor
///         on filter events.
interface ICreatorFeeDistributor {}

interface ICreatorRegistry {
    function creatorOf(address token) external view returns (address);
}

/// @notice Per-token winner-settlement marker. Spec §9.4 (locked 2026-05-02): the WETH-leg
///         95-bps slice that fed the prize pool while the season was active routes to POL
///         once `winnerSettledAt > 0`. SeasonVault flips this on the WINNER's locker only at
///         `submitWinner` time. Non-winner pools never reach the call (their LP is unwound
///         and they never accrue post-settlement fees anyway).
interface IFilterLpLockerSettle {
    function markWinnerSettled() external;
}

interface ITournamentRegistry {
    function recordWeeklyWinner(uint256 seasonId, address token) external;
    function markFiltered(uint256 seasonId, address token) external;
}

/// @title SeasonVault
/// @notice Per-season escrow for the user-aligned settlement model. Accepts losers-pot
///         liquidations across multiple intra-week filter events, plus the final cut, and
///         distributes (in order):
///
///         - 2.5% champion bounty: skimmed off-the-top BEFORE the standard split, accumulated as
///           WETH, paid to the WINNER's creator at `submitWinner`. Aligns creators with not just
///           launching but with making the launch winning.
///
///         The remaining 97.5% is split per the user-aligned BPS:
///         - 45% rollover (WETH accumulated; converted to winner tokens at submitWinner)
///         - 25% bonus (WETH accumulated; forwarded to BonusDistributor at submitWinner)
///         - 10% mechanics (WETH transferred immediately, every event)
///         - 10% POL (WETH accumulated in `SeasonPOLReserve`; deployed only after winner)
///         - 10% treasury (WETH transferred immediately, every event)
///
///         POL is deliberately silent during the week — accumulated as WETH, never deployed
///         into a token that may yet be filtered. At finalization the reserve is drained, used
///         to buy winner tokens, and the result is parked in the singleton `POLVault`.
///
///         Trading-fee streams (FilterLpLocker → vault) accrue here too but are *not* split by
///         the losers-pot BPS — `processFilterEvent` measures the WETH delta produced by the
///         loser liquidations and only that delta gets the split. Trading-fee residue is swept
///         to the treasury at `submitWinner` time.
contract SeasonVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        Active, // accepting fees + filter events
        Distributing, // winner submitted; rollover claims open
        Closed
    }

    // -------- Losers-pot BPS split.
    //          BOUNTY_BPS comes off the TOP of the proceeds. The rest (97.5%) is split per the
    //          standard 45/25/10/10/10 four-way of rollover/bonus/mechanics/POL/treasury, all
    //          relative to `BPS_DENOMINATOR`.
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant BOUNTY_BPS = 250;
    uint256 public constant ROLLOVER_BPS = 4500;
    uint256 public constant BONUS_BPS = 2500;
    uint256 public constant MECHANICS_BPS = 1000;
    uint256 public constant POL_BPS = 1000;
    uint256 public constant TREASURY_BPS = 1000;

    // -------- Immutable wiring
    address public immutable launcher;
    uint256 public immutable seasonId;
    address public immutable weth;
    address public immutable treasury;
    address public immutable mechanics;
    /// @notice POL orchestrator. Receives the season's accumulated POL WETH at `submitWinner`
    ///         and turns it into a permanent V4 LP position on the winner pool. Records the
    ///         deployment on the singleton POLVault for indexer + UI visibility.
    IPOLManager public immutable polManager;
    IBonusFunding public immutable bonusDistributor;
    SeasonPOLReserve public immutable polReserve;
    uint256 public immutable bonusUnlockDelay;
    /// @notice Singleton creator-fee distributor. Vault calls `markFiltered` here when a token
    ///         is filtered so creator-fee accrual halts immediately for that token.
    ICreatorFeeDistributor public immutable creatorFeeDistributor;
    /// @notice Singleton (token → creator) registry. Used at `submitWinner` to look up the
    ///         winner's creator for the champion bounty payout.
    ICreatorRegistry public immutable creatorRegistry;
    /// @notice Singleton tournament metadata registry. The vault notifies it on every filter
    ///         event (markFiltered) and on submitWinner (recordWeeklyWinner) so the
    ///         token-status ladder for the multi-timescale championship structure stays in
    ///         sync with the weekly outcomes.
    ITournamentRegistry public immutable tournamentRegistry;

    // -------- Mutable state
    Phase public phase;

    // Accumulators across filter events, denominated in WETH and held by this contract until
    // `submitWinner` consumes them.
    uint256 public rolloverReserve;
    uint256 public bonusReserve;
    /// @notice Champion bounty accumulator. Paid to the winner's creator at `submitWinner`
    ///         (or rerouted to treasury if the winner has no registered creator — should not
    ///         happen since launcher always registers, but defends against edge cases).
    uint256 public bountyReserve;

    // Cumulative liquidation accounting (for indexer + sanity checks).
    uint256 public totalLiquidationProceeds;
    uint256 public totalMechanicsPaid;
    uint256 public totalTreasuryPaid;
    uint256 public totalPolAccumulated;
    uint256 public totalBountyAccumulated;
    uint256 public bountyPaid;
    address public bountyRecipient;
    uint256 public filterEventCount;

    // Per-token state.
    mapping(address => bool) public liquidated;
    address[] internal _losers;

    // Winner / claim state, populated at submitWinner.
    address public winner;
    /// @notice Block timestamp at which the winner was committed via `submitWinner`. Zero while
    ///         the season is still active. Mirrors the per-locker `winnerSettledAt` flag the
    ///         vault sets on the winner's locker (spec §9.4) so indexer + UI consumers can
    ///         resolve "is post-settlement routing in effect?" in a single read against the
    ///         vault without dereferencing the locker.
    uint256 public winnerSettledAt;
    bytes32 public rolloverRoot;
    uint256 public totalRolloverShares;
    uint256 public rolloverWinnerTokens;
    uint256 public bonusFunded;
    uint256 public polDeployedWeth;
    uint256 public polDeployedTokens;
    uint128 public polDeployedLiquidity;
    uint256 public claimedRolloverShares;
    mapping(address => bool) public claimed;

    // -------- Events
    event FilterEventProcessed(
        uint256 indexed eventIndex,
        uint256 loserCount,
        uint256 proceedsWeth,
        uint256 bountySlice,
        uint256 rolloverSlice,
        uint256 bonusSlice,
        uint256 mechanicsSlice,
        uint256 polSlice,
        uint256 treasurySlice
    );
    event ChampionBountyPaid(address indexed winner, address indexed creator, uint256 amount);
    event ChampionBountyRedirected(address indexed winner, uint256 amount);
    event Liquidated(address indexed token, uint256 wethOut);
    event WinnerSubmitted(address indexed winner, bytes32 rolloverRoot, uint256 totalRolloverShares);
    event Finalized(
        uint256 rolloverWethConsumed,
        uint256 rolloverWinnerTokens,
        uint256 bonusFunded,
        uint256 polDeployedWeth,
        uint256 polDeployedTokens,
        uint256 tradingFeeSweptToTreasury
    );
    event RolloverClaimed(address indexed user, uint256 share, uint256 winnerTokens);

    // -------- Errors
    error NotOracle();
    error WrongPhase();
    error AlreadyLiquidated();
    error LengthMismatch();
    error EmptyEvent();
    error BadWinner();
    error BadLoser();
    error WinnerWasFiltered();
    error ZeroShares();
    error AlreadyClaimed();
    error InvalidProof();
    error NoRollover();

    /// @dev Live-read against `launcher.oracle()` — see `ILauncherView.oracle()` rationale.
    ///      A modifier read costs one extra view call per privileged entry, well below the
    ///      gas-budget headroom on these settlement-side functions.
    modifier onlyOracle() {
        if (msg.sender != ILauncherView(launcher).oracle()) revert NotOracle();
        _;
    }

    modifier inPhase(Phase p) {
        if (phase != p) revert WrongPhase();
        _;
    }

    /// @dev `oracle` is intentionally NOT a constructor param — vault auth reads
    ///      `launcher.oracle()` live via `onlyOracle`. See audit H-2.
    constructor(
        address launcher_,
        uint256 seasonId_,
        address weth_,
        address treasury_,
        address mechanics_,
        IPOLManager polManager_,
        IBonusFunding bonusDistributor_,
        uint256 bonusUnlockDelay_,
        ICreatorRegistry creatorRegistry_,
        ICreatorFeeDistributor creatorFeeDistributor_,
        ITournamentRegistry tournamentRegistry_
    ) {
        launcher = launcher_;
        seasonId = seasonId_;
        weth = weth_;
        treasury = treasury_;
        mechanics = mechanics_;
        polManager = polManager_;
        bonusDistributor = bonusDistributor_;
        bonusUnlockDelay = bonusUnlockDelay_;
        creatorRegistry = creatorRegistry_;
        creatorFeeDistributor = creatorFeeDistributor_;
        tournamentRegistry = tournamentRegistry_;
        phase = Phase.Active;
        // Each season gets its own POL reserve so accumulated WETH is strictly scoped to the
        // current cohort and can't be commingled across seasons.
        polReserve = new SeasonPOLReserve(address(this), weth_, seasonId_);
    }

    // ============================================================ Filter events

    /// @notice Oracle drives one filter event: liquidates the named tokens (each via its
    ///         FilterLpLocker), measures the WETH delta produced, and applies the losers-pot
    ///         BPS split. Mechanics + treasury are paid immediately; rollover + bonus
    ///         accumulate as WETH inside this contract; POL is forwarded to `polReserve`.
    ///
    ///         Multi-call: invoked once per cut throughout the week. The final filter event
    ///         is just another call; it's `submitWinner` that locks the winner.
    function processFilterEvent(address[] calldata losers_, uint256[] calldata minOuts_)
        external
        onlyOracle
        nonReentrant
        inPhase(Phase.Active)
    {
        if (losers_.length == 0) revert EmptyEvent();
        if (losers_.length != minOuts_.length) revert LengthMismatch();

        uint256 wethBefore = IERC20(weth).balanceOf(address(this));

        for (uint256 i = 0; i < losers_.length; ++i) {
            address t = losers_[i];
            if (t == address(0)) revert BadLoser();
            if (liquidated[t]) revert AlreadyLiquidated();
            liquidated[t] = true;
            _losers.push(t);

            // Per spec §10.3 (Epic 1.16): creator-fee accrual is perpetual; we no longer notify
            // the distributor on filter events. The pool's LP is about to be unwound below, so
            // there are no more swaps and no more fees — accrual stops naturally without any
            // explicit hook.
            // Stamp the token's tournament status as FILTERED so it's permanently ineligible
            // for quarterly/annual qualification. The registry is no-op-safe if the status is
            // already non-ACTIVE (defensive against re-entry of an already-titled token).
            tournamentRegistry.markFiltered(seasonId, t);

            address locker = ILauncherView(launcher).lockerOf(seasonId, t);
            uint256 out = ILpLocker(locker).liquidateToWETH(address(this), minOuts_[i]);
            emit Liquidated(t, out);
        }

        uint256 proceeds = IERC20(weth).balanceOf(address(this)) - wethBefore;
        // Trading-fee accrual or external transfers in the same block could in principle inflate
        // the delta; that's acceptable here — over-attributing fees to losers-pot is benign for
        // the user-aligned splits and the trading-fee residue gets swept later.
        if (proceeds == 0) {
            // Liquidations produced no WETH (e.g. all losers had drained pools). Still count
            // the event so the index is consistent.
            ++filterEventCount;
            emit FilterEventProcessed(filterEventCount, losers_.length, 0, 0, 0, 0, 0, 0, 0);
            return;
        }

        // Champion bounty comes off the top before the standard losers-pot split.
        uint256 bountySlice = (proceeds * BOUNTY_BPS) / BPS_DENOMINATOR;
        uint256 remainder = proceeds - bountySlice;

        uint256 rolloverSlice = (remainder * ROLLOVER_BPS) / BPS_DENOMINATOR;
        uint256 bonusSlice = (remainder * BONUS_BPS) / BPS_DENOMINATOR;
        uint256 mechanicsSlice = (remainder * MECHANICS_BPS) / BPS_DENOMINATOR;
        uint256 polSlice = (remainder * POL_BPS) / BPS_DENOMINATOR;
        // Treasury takes whatever rounding dust falls out of the integer math so the four
        // exact-BPS slices are preserved and totalSlices == remainder by construction.
        uint256 treasurySlice = remainder - rolloverSlice - bonusSlice - mechanicsSlice - polSlice;

        rolloverReserve += rolloverSlice;
        bonusReserve += bonusSlice;
        bountyReserve += bountySlice;
        totalLiquidationProceeds += proceeds;
        totalMechanicsPaid += mechanicsSlice;
        totalTreasuryPaid += treasurySlice;
        totalPolAccumulated += polSlice;
        totalBountyAccumulated += bountySlice;
        ++filterEventCount;

        if (mechanicsSlice > 0) IERC20(weth).safeTransfer(mechanics, mechanicsSlice);
        if (treasurySlice > 0) IERC20(weth).safeTransfer(treasury, treasurySlice);
        if (polSlice > 0) {
            IERC20(weth).safeTransfer(address(polReserve), polSlice);
            polReserve.notifyDeposit(polSlice);
        }

        emit FilterEventProcessed(
            filterEventCount,
            losers_.length,
            proceeds,
            bountySlice,
            rolloverSlice,
            bonusSlice,
            mechanicsSlice,
            polSlice,
            treasurySlice
        );
    }

    // ============================================================ Final settlement

    /// @notice One-shot: oracle commits the winner + rollover Merkle root after all filter
    ///         events have completed. Consumes the accumulated rollover/bonus reserves, drains
    ///         the POL reserve, deploys POL into the winner token, and transitions to
    ///         Distributing so users can claim. Trading-fee residue (anything in this contract
    ///         beyond the named reserves) is swept to treasury so the vault closes clean.
    function submitWinner(
        address winner_,
        bytes32 rolloverRoot_,
        uint256 totalRolloverShares_,
        uint256 minWinnerTokensRollover,
        uint256 minWinnerTokensPol
    ) external onlyOracle nonReentrant inPhase(Phase.Active) {
        if (winner_ == address(0)) revert BadWinner();
        if (liquidated[winner_]) revert WinnerWasFiltered();
        if (totalRolloverShares_ == 0) revert ZeroShares();

        winner = winner_;
        winnerSettledAt = block.timestamp;
        rolloverRoot = rolloverRoot_;
        totalRolloverShares = totalRolloverShares_;
        emit WinnerSubmitted(winner_, rolloverRoot_, totalRolloverShares_);

        // Stamp WEEKLY_WINNER on the tournament registry so this token qualifies for the
        // upcoming quarterly Filter Bowl. Registry handles auth via launcher.vaultOf and is
        // idempotent per season.
        tournamentRegistry.recordWeeklyWinner(seasonId, winner_);

        address winnerLocker = ILauncherView(launcher).lockerOf(seasonId, winner_);
        // Spec §9.4: flip the winner's locker into post-settlement fee routing. From the next
        // swap forward, the WETH-leg slice that fed the prize pool routes to POL Vault instead
        // (compounds winner backing per §11.7). Idempotent on the locker side; vault calls
        // exactly once and the locker reverts on re-call.
        IFilterLpLockerSettle(winnerLocker).markWinnerSettled();

        // 0. Champion bounty → winner's creator. Reroute to treasury if (somehow) no creator
        //    is registered for the winner; the launcher path always registers, so this branch
        //    is defensive only.
        uint256 bounty = bountyReserve;
        bountyReserve = 0;
        if (bounty > 0) {
            address creator = creatorRegistry.creatorOf(winner_);
            if (creator == address(0)) {
                IERC20(weth).safeTransfer(treasury, bounty);
                emit ChampionBountyRedirected(winner_, bounty);
            } else {
                bountyRecipient = creator;
                bountyPaid = bounty;
                IERC20(weth).safeTransfer(creator, bounty);
                emit ChampionBountyPaid(winner_, creator, bounty);
            }
        }

        // 1. Bonus reserve → BonusDistributor (still WETH; converts to user payouts later).
        uint256 bonusAmount = bonusReserve;
        bonusReserve = 0;
        if (bonusAmount > 0) {
            IERC20(weth).forceApprove(address(bonusDistributor), bonusAmount);
            bonusDistributor.fundBonus(seasonId, winner_, block.timestamp + bonusUnlockDelay, bonusAmount);
        }
        bonusFunded = bonusAmount;

        // 2. Rollover reserve → buy winner tokens, retained for Merkle claim.
        uint256 rolloverAmount = rolloverReserve;
        rolloverReserve = 0;
        if (rolloverAmount > 0) {
            IERC20(weth).forceApprove(winnerLocker, rolloverAmount);
            rolloverWinnerTokens = ILpLocker(winnerLocker)
                .buyTokenWithWETH(rolloverAmount, address(this), minWinnerTokensRollover);
        }

        // 3. POL → withdraw WETH, hand to POLManager which adds a permanent V4 LP position
        //    on the winner pool (swap-half + addLiquidity owned by the locker). The
        //    `minWinnerTokensPol` floor is the oracle's TWAP-based slippage guard on the
        //    locker's swap leg — without it, this publicly-visible tx is sandwich-bait.
        uint256 polAmount = polReserve.withdrawAll();
        uint256 polTokensOut = 0;
        uint128 polLiq = 0;
        if (polAmount > 0) {
            IERC20(weth).forceApprove(address(polManager), polAmount);
            (, polTokensOut, polLiq) = polManager.deployPOL(seasonId, winner_, polAmount, minWinnerTokensPol);
        }
        polDeployedWeth = polAmount;
        polDeployedTokens = polTokensOut;
        polDeployedLiquidity = polLiq;

        // 4. Trading-fee residue (whatever WETH is still here that isn't claim-bound) → treasury.
        //    `winner` tokens are claim-bound; remaining WETH is fee residue.
        uint256 residue = IERC20(weth).balanceOf(address(this));
        if (residue > 0) {
            IERC20(weth).safeTransfer(treasury, residue);
            totalTreasuryPaid += residue;
        }

        phase = Phase.Distributing;
        emit Finalized(rolloverAmount, rolloverWinnerTokens, bonusAmount, polAmount, polTokensOut, residue);
    }

    // ============================================================ Rollover claim

    /// @notice Claim a rollover allocation. Merkle leaf is `(user, share)`; payout converts the
    ///         share to its proportional cut of `rolloverWinnerTokens`. Behavior unchanged from
    ///         the prior model — only the upstream allocation logic was reworked.
    function claimRollover(uint256 share, bytes32[] calldata proof)
        external
        nonReentrant
        inPhase(Phase.Distributing)
    {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        if (rolloverWinnerTokens == 0) revert NoRollover();
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, share));
        if (!MerkleProof.verifyCalldata(proof, rolloverRoot, leaf)) revert InvalidProof();

        uint256 amount = (share * rolloverWinnerTokens) / totalRolloverShares;
        claimed[msg.sender] = true;
        claimedRolloverShares += share;
        IERC20(winner).safeTransfer(msg.sender, amount);
        emit RolloverClaimed(msg.sender, share, amount);
    }

    // ============================================================ Views

    function losersList() external view returns (address[] memory) {
        return _losers;
    }

    function loserCount() external view returns (uint256) {
        return _losers.length;
    }

    /// @notice Live POL reserve balance — the WETH that *will* back the winner once the season
    ///         ends. Surfaces directly to the indexer so the broadcast UI can show the
    ///         accumulating "winner backing" number.
    function polReserveBalance() external view returns (uint256) {
        return polReserve.getTotalPOL();
    }
}
