// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILpLocker} from "./interfaces/ILpLocker.sol";

interface IBonusFunding {
    function fundBonus(uint256 seasonId, address winnerToken, uint256 unlockTime, uint256 amount) external;
}

interface ILauncherView {
    function lockerOf(uint256 seasonId, address token) external view returns (address);
}

/// @title SeasonVault
/// @notice Per-season escrow. Lifecycle: receive fees from each token's `FilterLpLocker` during
///         the week → on settlement, oracle posts the ranking → keeper drives `liquidate(token)`
///         once per losing token → `finalize()` allocates the pot → users claim rollover via
///         Merkle proof. Bonus reserve is forwarded to `BonusDistributor` at finalize.
///
///         Allocation policy:
///         - 35% rollover (winner-token buy, distributed via Merkle)
///         - 15% bonus reserve (forwarded to BonusDistributor)
///         - 20% POL (winner-token buy retained by `polRecipient`)
///         - 20% treasury (WETH to TreasuryTimelock)
///         - 10% mechanics (WETH to events/missions wallet)
contract SeasonVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        Active, // accepting fees, awaiting settlement
        Liquidating, // settlement posted, draining loser positions
        Aggregating, // all liquidated, awaiting finalize
        Distributing, // pot allocated; rollover claims open
        Closed
    }

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant ROLLOVER_BPS = 3500;
    uint256 public constant BONUS_BPS = 1500;
    uint256 public constant POL_BPS = 2000;
    uint256 public constant TREASURY_BPS = 2000;
    uint256 public constant MECHANICS_BPS = 1000;

    // Immutable wiring
    address public immutable launcher;
    uint256 public immutable seasonId;
    address public immutable weth;
    address public immutable treasury;
    address public immutable mechanics;
    address public immutable polRecipient;
    IBonusFunding public immutable bonusDistributor;
    uint256 public immutable bonusUnlockDelay;

    // Mutable state
    address public oracle;
    Phase public phase;

    address public winner;
    bytes32 public rolloverRoot;
    uint256 public totalRolloverShares;
    uint256 public liquidationDeadline;

    address[] internal losers;
    mapping(address => bool) public isLoser;
    mapping(address => bool) public liquidated;
    mapping(address => uint256) public minOutFor;
    uint256 public liquidatedCount;

    uint256 public totalPot;
    uint256 public rolloverWinnerTokens;
    uint256 public bonusReserve;
    uint256 public claimedRolloverShares;
    mapping(address => bool) public claimed;

    event SettlementSubmitted(
        address indexed winner,
        uint256 loserCount,
        bytes32 rolloverRoot,
        uint256 totalRolloverShares,
        uint256 liquidationDeadline
    );
    event Liquidated(address indexed token, uint256 wethOut);
    event Finalized(uint256 totalPot, uint256 rolloverWinnerTokens, uint256 bonusReserve);
    event RolloverClaimed(address indexed user, uint256 share, uint256 winnerTokens);
    event ForceClosed(address by);

    error NotOracle();
    error NotLauncher();
    error WrongPhase();
    error UnknownLoser();
    error AlreadyLiquidated();
    error AlreadyClaimed();
    error InvalidProof();
    error DeadlineNotPassed();
    error LengthMismatch();
    error BadWinner();
    error DuplicateLoser();
    error DeadlineTooClose();
    error ZeroShares();
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
        address polRecipient_,
        IBonusFunding bonusDistributor_,
        uint256 bonusUnlockDelay_
    ) {
        launcher = launcher_;
        seasonId = seasonId_;
        weth = weth_;
        oracle = oracle_;
        treasury = treasury_;
        mechanics = mechanics_;
        polRecipient = polRecipient_;
        bonusDistributor = bonusDistributor_;
        bonusUnlockDelay = bonusUnlockDelay_;
        phase = Phase.Active;
    }

    // ============================================================ Settlement

    function submitSettlement(
        address winner_,
        address[] calldata losers_,
        uint256[] calldata minOuts_,
        bytes32 rolloverRoot_,
        uint256 totalRolloverShares_,
        uint256 liquidationDeadline_
    ) external onlyOracle inPhase(Phase.Active) {
        if (losers_.length != minOuts_.length) revert LengthMismatch();
        if (winner_ == address(0)) revert BadWinner();
        if (totalRolloverShares_ == 0) revert ZeroShares();
        if (liquidationDeadline_ <= block.timestamp) revert DeadlineTooClose();

        winner = winner_;
        rolloverRoot = rolloverRoot_;
        totalRolloverShares = totalRolloverShares_;
        liquidationDeadline = liquidationDeadline_;

        for (uint256 i = 0; i < losers_.length; ++i) {
            address t = losers_[i];
            if (t == winner_ || t == address(0)) revert BadWinner();
            if (isLoser[t]) revert DuplicateLoser();
            isLoser[t] = true;
            minOutFor[t] = minOuts_[i];
            losers.push(t);
        }

        phase = Phase.Liquidating;
        emit SettlementSubmitted(winner_, losers_.length, rolloverRoot_, totalRolloverShares_, liquidationDeadline_);
    }

    /// @notice Permissionless. Drives one loser through `FilterLpLocker.liquidateToWETH`.
    function liquidate(address loserToken, uint256 minOutOverride)
        external
        nonReentrant
        inPhase(Phase.Liquidating)
    {
        if (!isLoser[loserToken]) revert UnknownLoser();
        if (liquidated[loserToken]) revert AlreadyLiquidated();
        uint256 floor = minOutFor[loserToken];
        uint256 minOut = minOutOverride >= floor ? minOutOverride : floor;

        liquidated[loserToken] = true;
        ++liquidatedCount;

        address locker = ILauncherView(launcher).lockerOf(seasonId, loserToken);
        uint256 out = ILpLocker(locker).liquidateToWETH(address(this), minOut);
        emit Liquidated(loserToken, out);

        if (liquidatedCount == losers.length) {
            phase = Phase.Aggregating;
        }
    }

    /// @notice Allocates the pot. `minWinnerTokens` is the rollover-buy slippage guard.
    function finalize(uint256 minWinnerTokensRollover, uint256 minWinnerTokensPol)
        external
        nonReentrant
        inPhase(Phase.Aggregating)
    {
        uint256 pot = IERC20(weth).balanceOf(address(this));
        totalPot = pot;

        uint256 rolloverSlice = (pot * ROLLOVER_BPS) / BPS_DENOMINATOR;
        uint256 bonusSlice = (pot * BONUS_BPS) / BPS_DENOMINATOR;
        uint256 polSlice = (pot * POL_BPS) / BPS_DENOMINATOR;
        uint256 treasurySlice = (pot * TREASURY_BPS) / BPS_DENOMINATOR;
        uint256 mechanicsSlice = pot - rolloverSlice - bonusSlice - polSlice - treasurySlice;

        // Bonus reserve → BonusDistributor
        bonusReserve = bonusSlice;
        if (bonusSlice > 0) {
            IERC20(weth).forceApprove(address(bonusDistributor), bonusSlice);
            bonusDistributor.fundBonus(seasonId, winner, block.timestamp + bonusUnlockDelay, bonusSlice);
        }

        // Treasury & mechanics → flat WETH transfer
        if (treasurySlice > 0) IERC20(weth).safeTransfer(treasury, treasurySlice);
        if (mechanicsSlice > 0) IERC20(weth).safeTransfer(mechanics, mechanicsSlice);

        address winnerLocker = ILauncherView(launcher).lockerOf(seasonId, winner);

        // POL → buy winner tokens, send to polRecipient
        if (polSlice > 0) {
            IERC20(weth).forceApprove(winnerLocker, polSlice);
            ILpLocker(winnerLocker).buyTokenWithWETH(polSlice, polRecipient, minWinnerTokensPol);
        }

        // Rollover → buy winner tokens, retained for Merkle claim
        if (rolloverSlice > 0) {
            IERC20(weth).forceApprove(winnerLocker, rolloverSlice);
            rolloverWinnerTokens = ILpLocker(winnerLocker)
                .buyTokenWithWETH(rolloverSlice, address(this), minWinnerTokensRollover);
        }

        phase = Phase.Distributing;
        emit Finalized(pot, rolloverWinnerTokens, bonusReserve);
    }

    // ============================================================ Rollover claim

    /// @notice Claim a rollover allocation. The Merkle leaf encodes the user's `share` (an
    ///         abstract weight committed at settlement time, before the AMM swap was executed).
    ///         Winner tokens received = `share * rolloverWinnerTokens / totalRolloverShares`.
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

    // ============================================================ Admin

    /// @notice After deadline, the launcher (multisig) advances the state machine so finalize()
    ///         can run on whatever WETH was actually gathered.
    function forceClose() external {
        if (msg.sender != launcher) revert NotLauncher();
        if (block.timestamp < liquidationDeadline) revert DeadlineNotPassed();
        if (phase != Phase.Liquidating) revert WrongPhase();
        phase = Phase.Aggregating;
        emit ForceClosed(msg.sender);
    }

    function losersList() external view returns (address[] memory) {
        return losers;
    }

    function loserCount() external view returns (uint256) {
        return losers.length;
    }
}
