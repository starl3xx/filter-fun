// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFilterClubPass} from "./interfaces/IFilterClubPass.sol";

/// @dev Minimal launcher surface the pass needs for trustless credit reclaim. `aborted` is
///      FilterLauncher's public mapping (spec §46): set before the escrow's `refundAll`
///      sweep, terminal, and mutually exclusive with activation — an aborted season can
///      never deploy, so restoring its consumed credits can never double-spend.
interface ILauncherAbortView {
    function aborted(uint256 seasonId) external view returns (bool);
}

/// @title FilterClubPass
/// @notice Filter Club founding-member lifetime pass (spec §47.3.8 / Epic 2.6). Fixed-supply
///         ERC-721 (genesis: 250 × 0.05 ETH), FCFS public mint, proceeds pushed per-mint to
///         `payoutRecipient` (genesis: the TreasuryTimelock — funds audit + treasury seed +
///         ops). Each pass carries `CREDITS_PER_TOKEN` lifetime free-launch credits, keyed
///         to the tokenId — credits travel with the NFT on transfer.
///
///         REDEMPTION MODEL. The launcher consults `consumeCredit` exactly once per
///         reservation — inside `reserve`'s payment check, only when `msg.value == 0` (an
///         unambiguous credit-intent signal). This contract makes no external calls and
///         moves no ETH in that path, and returns false rather than reverting on every
///         failure (no credit, season cap) so the launcher keeps its single
///         `InsufficientEscrow` error surface. A revert later in `reserve` rolls the
///         decrement back atomically.
///
///         ECONOMICS (audit note). A credit launch produces a zero-value escrow reservation
///         — a first-class case in LaunchEscrow/LauncherStakeAdmin (see LaunchEscrow.sol
///         `reservedAt != 0` sentinel). The waived slot cost is exactly the refundable
///         stake, so credit launches carry no forfeit deterrent; `seasonRedemptionCap`
///         bounds how many of a season's 12 slots can be credit-funded to keep zero-cost
///         slot-fill griefing bounded (genesis default: 4).
///
///         OWNERSHIP MODEL. Single-step `Ownable` matching FilterLauncher (see its header):
///         production owner MUST be the multisig; direct EOA ownership is for testnet /
///         genesis bring-up only.
contract FilterClubPass is IFilterClubPass, ERC721Enumerable, Ownable, Pausable, ReentrancyGuard {
    // ============================================================ Errors

    error SoldOut();
    error WrongPayment();
    error InvalidQuantity();
    error WalletCapExceeded();
    error NotLauncher();
    error AlreadySet();
    error ZeroAddress();
    error NothingToReclaim();
    error SeasonNotAborted();
    error PayoutFailed();
    error MetadataFrozen();
    error NotTokenOwner();

    // ============================================================ Events

    event Minted(address indexed to, uint256 indexed tokenId, uint256 pricePaid);
    event CreditConsumed(uint256 indexed tokenId, address indexed holder, uint256 indexed seasonId);
    event CreditReclaimed(uint256 indexed tokenId, address indexed creator, uint256 indexed seasonId);
    event CreditArmed(address indexed holder, uint256 indexed tokenId);
    event LauncherSet(address launcher);
    event PayoutRecipientSet(address payoutRecipient);
    event BaseURISet(string baseURI);
    event MetadataFrozenSet();
    event WalletMintCapSet(uint32 walletMintCap);
    event SeasonRedemptionCapSet(uint32 seasonRedemptionCap);

    // ============================================================ Config

    /// @notice Hard mint ceiling (genesis: 250). Immutable — the "250 founding members"
    ///         promise is load-bearing marketing; a mutable supply would be a rug surface.
    uint256 public immutable maxSupply;
    /// @notice Fixed FCFS mint price in wei (genesis: 0.05 ether).
    uint256 public immutable mintPrice;
    /// @notice Lifetime free-launch credits carried by every pass at mint.
    uint8 public constant CREDITS_PER_TOKEN = 2;

    /// @notice The FilterLauncher authorised to call `consumeCredit`. One-shot wired
    ///         post-deploy (`setLauncher`) — the pass deploys BEFORE the launcher because
    ///         the launcher takes this contract as an immutable constructor arg. Fails
    ///         safe: until wired, `consumeCredit` reverts `NotLauncher` for everyone.
    address public launcher;

    /// @notice Destination for mint proceeds, pushed per-mint so this contract's ETH
    ///         balance is invariantly zero. Genesis default: the TreasuryTimelock (open
    ///         `receive()`). RUNBOOK NOTE: rotating this to a non-receiving contract
    ///         bricks minting (mint reverts `PayoutFailed`) — verify `receive()`/payable
    ///         fallback before any rotation.
    address public payoutRecipient;

    /// @notice Per-wallet mint ceiling (genesis: 5). Counts mints, not holdings —
    ///         transfers don't free up mint quota (cheap sybil friction, not a hard cap).
    uint32 public walletMintCap;

    /// @notice Max credit redemptions per season (genesis: 4 of the 12 slots). Bounds
    ///         zero-stake slot-fill griefing; owner-tunable as the meta evolves.
    uint32 public seasonRedemptionCap = 4;

    /// @notice Metadata root. Owner-updatable until `freezeMetadata()` — one-way.
    string internal _baseTokenURI;
    bool public metadataFrozen;

    // ============================================================ State

    /// @dev Last minted tokenId. Ids start at 1 so 0 is usable as a "none" sentinel in
    ///      `_selectCreditToken` and the +1-offset mappings below.
    uint256 internal _lastTokenId;

    /// @notice Remaining free-launch credits per pass. Keyed to the tokenId — credits
    ///         travel with the NFT on transfer (spec §47.3.8, user-decided 2026-07-09).
    mapping(uint256 => uint8) public creditsOf;

    /// @notice Lifetime mints per wallet (see `walletMintCap`).
    mapping(address => uint32) public mintedBy;

    /// @notice Credit redemptions recorded per season (see `seasonRedemptionCap`).
    mapping(uint256 => uint32) public redemptionsInSeason;

    /// @notice seasonId → reserving creator → (consumed tokenId + 1); 0 = no record.
    ///         Written by `consumeCredit`, zeroed by `reclaimCredit`. The +1 offset
    ///         distinguishes "no record" from tokenId 0 (which never exists — ids start
    ///         at 1 — but the offset keeps the sentinel explicit).
    mapping(uint256 => mapping(address => uint256)) public consumedTokenOf;

    /// @notice holder → (preferred tokenId + 1) consulted first by `consumeCredit`'s
    ///         auto-select; 0 = no preference. Stale entries (token transferred away or
    ///         drained) are skipped, falling back to the enumeration scan.
    mapping(address => uint256) public armedTokenOf;

    // ============================================================ Constructor

    constructor(
        address owner_,
        address payoutRecipient_,
        string memory baseURI_,
        uint256 maxSupply_,
        uint256 mintPrice_,
        uint32 walletMintCap_
    ) ERC721("Filter Club", "FCLUB") Ownable(owner_) {
        // Audit H-4 pattern (FilterLauncher constructor): zero-checks at deploy time are
        // cheaper than discovering a bricked path post-launch.
        if (payoutRecipient_ == address(0)) revert ZeroAddress();
        if (maxSupply_ == 0 || walletMintCap_ == 0) revert InvalidQuantity();
        payoutRecipient = payoutRecipient_;
        _baseTokenURI = baseURI_;
        maxSupply = maxSupply_;
        mintPrice = mintPrice_;
        walletMintCap = walletMintCap_;
    }

    // ============================================================ Mint

    /// @notice FCFS public mint. Exact payment required (`mintPrice * qty`) — no dust, no
    ///         refund path. Proceeds push straight to `payoutRecipient` in the same tx.
    /// @dev    `_mint` (not `_safeMint`): no receiver callback, so the only external call
    ///         is the trusted payout push, after all effects, under `nonReentrant`.
    function mint(uint256 qty) external payable nonReentrant whenNotPaused {
        if (qty == 0) revert InvalidQuantity();
        uint256 last = _lastTokenId;
        if (last + qty > maxSupply) revert SoldOut();
        uint32 newMinted = mintedBy[msg.sender] + uint32(qty);
        if (newMinted > walletMintCap) revert WalletCapExceeded();
        if (msg.value != mintPrice * qty) revert WrongPayment();

        mintedBy[msg.sender] = newMinted;
        for (uint256 i = 1; i <= qty; ++i) {
            uint256 tokenId = last + i;
            creditsOf[tokenId] = CREDITS_PER_TOKEN;
            _mint(msg.sender, tokenId);
            emit Minted(msg.sender, tokenId, mintPrice);
        }
        _lastTokenId = last + qty;

        (bool ok,) = payoutRecipient.call{value: msg.value}("");
        if (!ok) revert PayoutFailed();
    }

    // ============================================================ Credit redemption

    /// @inheritdoc IFilterClubPass
    /// @dev No external calls, no ETH movement — see the launcher's step-8 comment for the
    ///      atomicity argument. Defense-in-depth: refuses a second consumption for the same
    ///      (season, holder) even though the launcher's per-wallet escrow cap already makes
    ///      that unreachable.
    function consumeCredit(address holder, uint256 seasonId) external returns (bool) {
        if (msg.sender != launcher) revert NotLauncher();
        if (redemptionsInSeason[seasonId] >= seasonRedemptionCap) return false;
        if (consumedTokenOf[seasonId][holder] != 0) return false;
        uint256 tokenId = _selectCreditToken(holder);
        if (tokenId == 0) return false;

        creditsOf[tokenId] -= 1;
        redemptionsInSeason[seasonId] += 1;
        consumedTokenOf[seasonId][holder] = tokenId + 1;
        emit CreditConsumed(tokenId, holder, seasonId);
        return true;
    }

    /// @notice Restore the credit consumed by `creator`'s reservation in an ABORTED season.
    ///         Callable by anyone (trustless — mirrors the escrow's permissionless refund
    ///         posture): the credit returns to the TOKEN, so the pass's current owner
    ///         benefits, consistent with credits travelling on transfer.
    /// @dev    No un-consume race exists: `aborted` is terminal and mutually exclusive with
    ///         activation, so a season whose credits are reclaimable can never deploy.
    ///         `redemptionsInSeason` is intentionally NOT decremented — the season is dead,
    ///         its cap is inert, and keeping the counter monotonic keeps the indexer's
    ///         consumed/reclaimed accounting additive.
    function reclaimCredit(uint256 seasonId, address creator) external {
        if (!ILauncherAbortView(launcher).aborted(seasonId)) revert SeasonNotAborted();
        uint256 record = consumedTokenOf[seasonId][creator];
        if (record == 0) revert NothingToReclaim();
        consumedTokenOf[seasonId][creator] = 0;
        uint256 tokenId = record - 1;
        creditsOf[tokenId] += 1;
        emit CreditReclaimed(tokenId, creator, seasonId);
    }

    /// @notice Pin which of your passes `consumeCredit` should draw from first. Optional —
    ///         auto-select falls back to the lowest-index owned pass with credits.
    function armCredit(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        armedTokenOf[msg.sender] = tokenId + 1;
        emit CreditArmed(msg.sender, tokenId);
    }

    /// @dev Armed preference first (skipped if transferred away or drained), then the
    ///      enumeration scan. Bounded: balanceOf ≤ maxSupply (250 at genesis), typical 1–5.
    ///      Returns 0 (never a valid id — ids start at 1) when no credit is available.
    function _selectCreditToken(address holder) internal view returns (uint256) {
        uint256 armed = armedTokenOf[holder];
        if (armed != 0) {
            uint256 t = armed - 1;
            if (_ownerOf(t) == holder && creditsOf[t] != 0) return t;
        }
        uint256 n = balanceOf(holder);
        for (uint256 i = 0; i < n; ++i) {
            uint256 t = tokenOfOwnerByIndex(holder, i);
            if (creditsOf[t] != 0) return t;
        }
        return 0;
    }

    // ============================================================ Views

    /// @notice Total passes minted (no burn path — equals totalSupply, kept as an explicit
    ///         name for the mint page's progress bar).
    function totalMinted() external view returns (uint256) {
        return _lastTokenId;
    }

    /// @notice Sum of credits across every pass `holder` currently owns. Web/display only —
    ///         the launcher path never calls this.
    function creditsRemaining(address holder) external view returns (uint256 total) {
        uint256 n = balanceOf(holder);
        for (uint256 i = 0; i < n; ++i) {
            total += creditsOf[tokenOfOwnerByIndex(holder, i)];
        }
    }

    // ============================================================ Owner / wiring

    /// @notice One-shot launcher wire. See `launcher` NatSpec for the deploy-order dance.
    function setLauncher(address launcher_) external onlyOwner {
        if (launcher != address(0)) revert AlreadySet();
        if (launcher_ == address(0)) revert ZeroAddress();
        launcher = launcher_;
        emit LauncherSet(launcher_);
    }

    function setPayoutRecipient(address payoutRecipient_) external onlyOwner {
        if (payoutRecipient_ == address(0)) revert ZeroAddress();
        payoutRecipient = payoutRecipient_;
        emit PayoutRecipientSet(payoutRecipient_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        if (metadataFrozen) revert MetadataFrozen();
        _baseTokenURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    /// @notice One-way metadata freeze.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozenSet();
    }

    function setWalletMintCap(uint32 walletMintCap_) external onlyOwner {
        if (walletMintCap_ == 0) revert InvalidQuantity();
        walletMintCap = walletMintCap_;
        emit WalletMintCapSet(walletMintCap_);
    }

    function setSeasonRedemptionCap(uint32 seasonRedemptionCap_) external onlyOwner {
        seasonRedemptionCap = seasonRedemptionCap_;
        emit SeasonRedemptionCapSet(seasonRedemptionCap_);
    }

    /// @notice Mint kill switch (unaudited-mainnet posture). Pauses `mint` only — credit
    ///         consumption/reclaim stay live so the game path never depends on pause state.
    function setPaused(bool paused_) external onlyOwner {
        if (paused_) _pause();
        else _unpause();
    }

    // ============================================================ Internals

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
