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

interface IPOLVault {
    function deposit(uint256 seasonId, address winnerToken, uint256 amount) external;
}

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
}

/// @title SeasonVault
/// @notice Per-season escrow for the user-aligned settlement model. Accepts losers-pot
///         liquidations across multiple intra-week filter events, plus the final cut, and
///         distributes:
///
///         - 45% rollover (WETH accumulated; converted to winner tokens at finalize)
///         - 25% bonus (WETH accumulated; forwarded to BonusDistributor at finalize)
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

    // -------- Losers-pot BPS split (sums to 10_000)
    uint256 internal constant BPS_DENOMINATOR = 10_000;
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
    address public immutable polVault;
    IBonusFunding public immutable bonusDistributor;
    SeasonPOLReserve public immutable polReserve;
    uint256 public immutable bonusUnlockDelay;

    // -------- Mutable state
    address public oracle;
    Phase public phase;

    // Accumulators across filter events, denominated in WETH and held by this contract until
    // `submitWinner` consumes them.
    uint256 public rolloverReserve;
    uint256 public bonusReserve;

    // Cumulative liquidation accounting (for indexer + sanity checks).
    uint256 public totalLiquidationProceeds;
    uint256 public totalMechanicsPaid;
    uint256 public totalTreasuryPaid;
    uint256 public totalPolAccumulated;
    uint256 public filterEventCount;

    // Per-token state.
    mapping(address => bool) public liquidated;
    address[] internal _losers;

    // Winner / claim state, populated at submitWinner.
    address public winner;
    bytes32 public rolloverRoot;
    uint256 public totalRolloverShares;
    uint256 public rolloverWinnerTokens;
    uint256 public bonusFunded;
    uint256 public polDeployedWeth;
    uint256 public polDeployedTokens;
    uint256 public claimedRolloverShares;
    mapping(address => bool) public claimed;

    // -------- Events
    event FilterEventProcessed(
        uint256 indexed eventIndex,
        uint256 loserCount,
        uint256 proceedsWeth,
        uint256 rolloverSlice,
        uint256 bonusSlice,
        uint256 mechanicsSlice,
        uint256 polSlice,
        uint256 treasurySlice
    );
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
    error WinnerWasFiltered();
    error ZeroShares();
    error AlreadyClaimed();
    error InvalidProof();
    error NoRollover();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    modifier inPhase(Phase p) {
        if (phase != p) revert WrongPhase();
        _;
    }

    constructor(
        address launcher_,
        uint256 seasonId_,
        address weth_,
        address oracle_,
        address treasury_,
        address mechanics_,
        address polVault_,
        IBonusFunding bonusDistributor_,
        uint256 bonusUnlockDelay_
    ) {
        launcher = launcher_;
        seasonId = seasonId_;
        weth = weth_;
        oracle = oracle_;
        treasury = treasury_;
        mechanics = mechanics_;
        polVault = polVault_;
        bonusDistributor = bonusDistributor_;
        bonusUnlockDelay = bonusUnlockDelay_;
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
            if (t == address(0)) revert BadWinner();
            if (liquidated[t]) revert AlreadyLiquidated();
            liquidated[t] = true;
            _losers.push(t);

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
            emit FilterEventProcessed(filterEventCount, losers_.length, 0, 0, 0, 0, 0, 0);
            return;
        }

        uint256 rolloverSlice = (proceeds * ROLLOVER_BPS) / BPS_DENOMINATOR;
        uint256 bonusSlice = (proceeds * BONUS_BPS) / BPS_DENOMINATOR;
        uint256 mechanicsSlice = (proceeds * MECHANICS_BPS) / BPS_DENOMINATOR;
        uint256 polSlice = (proceeds * POL_BPS) / BPS_DENOMINATOR;
        // Treasury takes whatever rounding dust falls out of the integer math so the four
        // exact-BPS slices are preserved and totalSlices == proceeds by construction.
        uint256 treasurySlice = proceeds - rolloverSlice - bonusSlice - mechanicsSlice - polSlice;

        rolloverReserve += rolloverSlice;
        bonusReserve += bonusSlice;
        totalLiquidationProceeds += proceeds;
        totalMechanicsPaid += mechanicsSlice;
        totalTreasuryPaid += treasurySlice;
        totalPolAccumulated += polSlice;
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
        rolloverRoot = rolloverRoot_;
        totalRolloverShares = totalRolloverShares_;
        emit WinnerSubmitted(winner_, rolloverRoot_, totalRolloverShares_);

        address winnerLocker = ILauncherView(launcher).lockerOf(seasonId, winner_);

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
            rolloverWinnerTokens =
                ILpLocker(winnerLocker).buyTokenWithWETH(rolloverAmount, address(this), minWinnerTokensRollover);
        }

        // 3. POL → withdraw, buy winner tokens, deposit into POLVault.
        uint256 polAmount = polReserve.withdrawAll();
        uint256 polTokensOut = 0;
        if (polAmount > 0) {
            IERC20(weth).forceApprove(winnerLocker, polAmount);
            polTokensOut = ILpLocker(winnerLocker).buyTokenWithWETH(polAmount, address(this), minWinnerTokensPol);
            IERC20(winner_).forceApprove(polVault, polTokensOut);
            IPOLVault(polVault).deposit(seasonId, winner_, polTokensOut);
        }
        polDeployedWeth = polAmount;
        polDeployedTokens = polTokensOut;

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
