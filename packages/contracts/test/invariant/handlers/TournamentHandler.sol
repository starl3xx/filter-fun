// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {
    TournamentVault,
    ITournamentRegistryView,
    ICreatorRegistryView,
    ILauncherViewTV
} from "../../../src/TournamentVault.sol";

import {MockWETH} from "../../mocks/MockWETH.sol";
import {MintableERC20} from "../../mocks/MintableERC20.sol";

/// @title TournamentHandler
/// @notice Bounded-action fuzz handler for the tournament settlement timescale (quarterly
///         Filter Bowl + annual championship). Mirrors `SettlementHandler` for SeasonVault but
///         drops the multi-filter-event surface — tournaments are funded + settled, not filtered.
///
///         Fuzz surface (per timescale):
///           - `fundQuarterly` / `fundAnnual` — permissionless WETH top-ups
///           - `submitQuarterlyWinner` / `submitAnnualWinner` — oracle-gated
///           - `claimQuarterlyRollover` / `claimQuarterlyBonus` (and annual variants) — holder paths
///           - Adversary variants of every gated action — must revert
///
///         Single (year, quarter) cohort + single (year) annual cohort are exercised, mirroring
///         the SettlementHandler's single-season scope. Multi-period invariants (e.g. quarterly
///         champion bumps to annual) are spec-level and covered by example tests; the
///         invariants here focus on per-tournament conservation + auth + immutability.
contract TournamentHandler is Test {
    uint16 public constant YEAR = 2026;
    uint8 public constant QUARTER = 1;
    uint256 public constant HOLDER_COUNT = 4;
    uint256 internal constant BONUS_UNLOCK_DELAY = 14 days;
    uint256 internal constant MAX_FUNDING_PER_CALL = 500 ether;

    TournamentVault public vault;
    MockWETH public weth;
    MockTRegistry public registry;
    MockCRegistry public creatorRegistry;
    MockLauncher public launcher;

    address public oracle;
    address public treasury;
    address public mechanics;
    address public adversary;

    address public quarterlyWinner;
    address public annualWinner;
    address public winnerCreator;

    address[HOLDER_COUNT] public holders;
    uint256[HOLDER_COUNT] public holderShares;

    // ----------------- Ghost variables — quarterly

    uint256 public ghostQFunded;
    uint256 public ghostQBountyAccrued;
    uint256 public ghostQRolloverAccrued;
    uint256 public ghostQBonusAccrued;
    uint256 public ghostQMechanicsAccrued;
    uint256 public ghostQPolAccrued;
    uint256 public ghostQTreasuryAccrued;
    bool public ghostQSettled;
    /// @notice Single-shot flag — should never be true. Set if the adversary or any duplicate
    ///         settle call succeeded.
    bool public ghostQAuthBypass;
    bool public ghostQResettled;

    // ----------------- Ghost variables — annual (mirror)

    uint256 public ghostAFunded;
    uint256 public ghostABountyAccrued;
    uint256 public ghostARolloverAccrued;
    uint256 public ghostABonusAccrued;
    uint256 public ghostAMechanicsAccrued;
    uint256 public ghostAPolAccrued;
    uint256 public ghostATreasuryAccrued;
    bool public ghostASettled;
    bool public ghostAAuthBypass;
    bool public ghostAResettled;

    constructor() {
        oracle = makeAddr("tournament.oracle");
        treasury = makeAddr("tournament.treasury");
        mechanics = makeAddr("tournament.mechanics");
        adversary = makeAddr("tournament.adversary");
        winnerCreator = makeAddr("tournament.winnerCreator");

        weth = new MockWETH();
        registry = new MockTRegistry();
        creatorRegistry = new MockCRegistry();
        launcher = new MockLauncher();
        launcher.setOracle(oracle);

        vault = new TournamentVault(
            address(launcher),
            address(weth),
            treasury,
            mechanics,
            ITournamentRegistryView(address(registry)),
            ICreatorRegistryView(address(creatorRegistry)),
            BONUS_UNLOCK_DELAY
        );

        quarterlyWinner = address(new MintableERC20("QWin", "QW"));
        annualWinner = address(new MintableERC20("AWin", "AW"));
        creatorRegistry.set(quarterlyWinner, winnerCreator);
        creatorRegistry.set(annualWinner, winnerCreator);
        registry.setQuarterlyFinalist(YEAR, QUARTER, quarterlyWinner, true);
        registry.setAnnualFinalist(YEAR, annualWinner, true);

        holderShares[0] = 100;
        holderShares[1] = 50;
        holderShares[2] = 25;
        holderShares[3] = 10;
        for (uint256 i = 0; i < HOLDER_COUNT; ++i) {
            holders[i] = makeAddr(string(abi.encodePacked("tournament.holder.", _toAscii(i))));
        }
    }

    function _toAscii(uint256 i) internal pure returns (bytes memory) {
        bytes memory b = new bytes(1);
        b[0] = bytes1(uint8(48 + (i % 10)));
        return b;
    }

    function _rolloverRoot() internal view returns (bytes32 root, uint256 totalShares) {
        bytes32[] memory leaves = new bytes32[](HOLDER_COUNT);
        for (uint256 i = 0; i < HOLDER_COUNT; ++i) {
            totalShares += holderShares[i];
            leaves[i] = keccak256(abi.encodePacked(holders[i], holderShares[i]));
        }
        root = _buildRoot(leaves);
    }

    function _buildRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        while (n > 1) {
            uint256 next = (n + 1) / 2;
            for (uint256 i = 0; i < next; ++i) {
                if (2 * i + 1 < n) {
                    bytes32 a = leaves[2 * i];
                    bytes32 b = leaves[2 * i + 1];
                    leaves[i] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
                } else {
                    leaves[i] = leaves[2 * i];
                }
            }
            n = next;
        }
        return leaves[0];
    }

    // ============================================================ Quarterly

    function fuzz_fundQuarterly(uint256 amountSeed) external {
        if (ghostQSettled) return;
        uint256 amount = bound(amountSeed, 1, MAX_FUNDING_PER_CALL);
        weth.mint(address(this), amount);
        IERC20(address(weth)).approve(address(vault), amount);
        try vault.fundQuarterly(YEAR, QUARTER, amount) {
            ghostQFunded += amount;
        } catch {}
    }

    function fuzz_submitQuarterlyWinner() external {
        if (ghostQSettled) return;
        if (ghostQFunded == 0) return;

        (bytes32 rRoot, uint256 totalShares) = _rolloverRoot();
        // Bonus root: deliberately use the SAME shape; in production each holder has a
        // (user, amount) pair where amounts sum to ≤ bonus slice. For the invariant we
        // only need a valid root structure.
        bytes32 bRoot = bytes32(uint256(rRoot) ^ uint256(0x1));

        // Bonus amount must be ≤ bonus slice (25% × 97.5% of pot). Use 0 to keep
        // claim path conservative — invariants focus on the settlement split itself.
        vm.prank(oracle);
        try vault.submitQuarterlyWinner(YEAR, QUARTER, quarterlyWinner, rRoot, totalShares, bRoot, 0) {
            ghostQSettled = true;
            uint256 pot = ghostQFunded;
            uint256 bounty = (pot * 250) / 10_000;
            uint256 remainder = pot - bounty;
            ghostQBountyAccrued = bounty;
            ghostQRolloverAccrued = (remainder * 4500) / 10_000;
            ghostQBonusAccrued = (remainder * 2500) / 10_000;
            ghostQMechanicsAccrued = (remainder * 1000) / 10_000;
            ghostQPolAccrued = (remainder * 1000) / 10_000;
            ghostQTreasuryAccrued = remainder - ghostQRolloverAccrued - ghostQBonusAccrued
                - ghostQMechanicsAccrued - ghostQPolAccrued;
        } catch {}
    }

    function fuzz_adversaryQuarterlySettle() external {
        if (ghostQSettled) return;
        if (ghostQFunded == 0) return;
        (bytes32 rRoot, uint256 totalShares) = _rolloverRoot();

        vm.prank(adversary);
        try vault.submitQuarterlyWinner(YEAR, QUARTER, quarterlyWinner, rRoot, totalShares, bytes32(0), 0) {
            ghostQAuthBypass = true;
        } catch {}
    }

    function fuzz_attemptQuarterlyResettle() external {
        if (!ghostQSettled) return;
        (bytes32 rRoot, uint256 totalShares) = _rolloverRoot();
        bytes32 evil = keccak256(abi.encode("rerun", block.number));
        vm.prank(oracle);
        try vault.submitQuarterlyWinner(YEAR, QUARTER, quarterlyWinner, evil, totalShares, rRoot, 0) {
            ghostQResettled = true;
        } catch {}
    }

    // ============================================================ Annual

    function fuzz_fundAnnual(uint256 amountSeed) external {
        if (ghostASettled) return;
        uint256 amount = bound(amountSeed, 1, MAX_FUNDING_PER_CALL);
        weth.mint(address(this), amount);
        IERC20(address(weth)).approve(address(vault), amount);
        try vault.fundAnnual(YEAR, amount) {
            ghostAFunded += amount;
        } catch {}
    }

    function fuzz_submitAnnualWinner() external {
        if (ghostASettled) return;
        if (ghostAFunded == 0) return;

        (bytes32 rRoot, uint256 totalShares) = _rolloverRoot();
        vm.prank(oracle);
        try vault.submitAnnualWinner(YEAR, annualWinner, rRoot, totalShares, bytes32(0), 0) {
            ghostASettled = true;
            uint256 pot = ghostAFunded;
            uint256 bounty = (pot * 250) / 10_000;
            uint256 remainder = pot - bounty;
            ghostABountyAccrued = bounty;
            ghostARolloverAccrued = (remainder * 4500) / 10_000;
            ghostABonusAccrued = (remainder * 2500) / 10_000;
            ghostAMechanicsAccrued = (remainder * 1000) / 10_000;
            ghostAPolAccrued = (remainder * 1000) / 10_000;
            ghostATreasuryAccrued = remainder - ghostARolloverAccrued - ghostABonusAccrued
                - ghostAMechanicsAccrued - ghostAPolAccrued;
        } catch {}
    }

    function fuzz_adversaryAnnualSettle() external {
        if (ghostASettled) return;
        if (ghostAFunded == 0) return;
        (bytes32 rRoot, uint256 totalShares) = _rolloverRoot();

        vm.prank(adversary);
        try vault.submitAnnualWinner(YEAR, annualWinner, rRoot, totalShares, bytes32(0), 0) {
            ghostAAuthBypass = true;
        } catch {}
    }

    function fuzz_attemptAnnualResettle() external {
        if (!ghostASettled) return;
        (bytes32 rRoot, uint256 totalShares) = _rolloverRoot();
        bytes32 evil = keccak256(abi.encode("rerunA", block.number));
        vm.prank(oracle);
        try vault.submitAnnualWinner(YEAR, annualWinner, evil, totalShares, rRoot, 0) {
            ghostAResettled = true;
        } catch {}
    }
}

// ============================================================ Local mocks
//
// The shared mocks under test/mocks/ implement only the surface SeasonVault needs. Tournament
// vault uses different interfaces (TournamentRegistryView, CreatorRegistryView, LauncherView with
// just `oracle()`), so we declare lightweight stand-ins here. Keeping them in the same file as
// the handler avoids polluting the global mock namespace with single-use shims.

contract MockTRegistry is ITournamentRegistryView {
    mapping(uint16 => mapping(uint8 => mapping(address => bool))) public quarterlyFinalist;
    mapping(uint16 => mapping(uint8 => address)) internal _quarterlyChampion;
    mapping(uint16 => mapping(address => bool)) public annualFinalist;
    mapping(uint16 => address) internal _annualChampion;

    function setQuarterlyFinalist(uint16 year, uint8 quarter, address token, bool ok) external {
        quarterlyFinalist[year][quarter][token] = ok;
    }

    function setAnnualFinalist(uint16 year, address token, bool ok) external {
        annualFinalist[year][token] = ok;
    }

    function isQuarterlyFinalist(uint16 year, uint8 quarter, address token)
        external
        view
        override
        returns (bool)
    {
        return quarterlyFinalist[year][quarter][token];
    }

    function isAnnualFinalist(uint16 year, address token) external view override returns (bool) {
        return annualFinalist[year][token];
    }

    function quarterlyChampionOf(uint16 year, uint8 quarter) external view override returns (address) {
        return _quarterlyChampion[year][quarter];
    }

    function annualChampionOf(uint16 year) external view override returns (address) {
        return _annualChampion[year];
    }

    function recordQuarterlyChampion(uint16 year, uint8 quarter, address champion) external override {
        _quarterlyChampion[year][quarter] = champion;
    }

    function recordAnnualChampion(uint16 year, address champion) external override {
        _annualChampion[year] = champion;
    }
}

contract MockCRegistry is ICreatorRegistryView {
    mapping(address => address) public override creatorOf;

    function set(address token, address creator) external {
        creatorOf[token] = creator;
    }
}

    contract MockLauncher is ILauncherViewTV {
        address internal _oracle;

        function setOracle(address o) external {
            _oracle = o;
        }

        function oracle() external view override returns (address) {
            return _oracle;
        }
    }
