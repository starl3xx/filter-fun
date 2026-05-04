// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {FilterLauncher} from "../src/FilterLauncher.sol";
import {IFilterLauncher} from "../src/interfaces/IFilterLauncher.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {TournamentRegistry} from "../src/TournamentRegistry.sol";
import {ScriptUtils} from "./ScriptUtils.sol";

/// @notice Read-only operational verifier for the live Sepolia deploy.
///
///         Asserts that the deployed system matches the locked spec invariants:
///           1. FilterLauncher.launchEscrow() returns the manifest's launchEscrow address
///              (spec §46 deferred-activation: the launcher and escrow have a 1:1 lifetime
///              relationship; they MUST agree at deploy time).
///           2. CreatorRegistry has $FILTER registered (manifest.filterToken.address != 0
///              AND creatorRegistry.creatorOf(filterToken) != 0). Skipped via
///              SKIP_FILTER_TOKEN_CHECK=1 for verification before $FILTER seed.
///           3. TournamentRegistry.launcher() points back to the deployed FilterLauncher.
///           4. launcher.polManager() and launcher.treasury() match the manifest's
///              `addresses.polManager` and `addresses.treasuryTimelock`.
///           5. For every token in the current season: creatorRegistry.adminOf(token)
///              equals creatorRegistry.creatorOf(token) — i.e. no broken admin
///              assignments left dangling from a half-completed nominate/accept rotation.
///           6. Spec §4.6.1 protocol blocklist: the constructor-seeded entries are present
///              (FILTER, WETH, ETH, USDC, USDT, DAI all registered).
///
///         On success, emits a `VerifySepoliaOK` event from this script contract
///         (visible in the forge run trace; nothing is broadcast on chain). On any
///         failure the script reverts with an `AssertionFailed_<n>` message naming
///         the failed condition, so an operator scanning forge output can map the
///         revert string back to a section of this contract.
///
///         Read-only and idempotent — reruns produce identical results without
///         touching chain state. Designed to be invoked via:
///
///           forge script script/VerifySepolia.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
///
///         (no `--broadcast`, no key, no gas).
contract VerifySepolia is Script {
    /// @notice Emitted on successful verification. Surfaces the addresses and counts
    ///         actually inspected so an operator can correlate the trace against the
    ///         manifest without re-parsing the JSON.
    event VerifySepoliaOK(
        uint256 chainId,
        address filterLauncher,
        address launchEscrow,
        bool filterTokenChecked,
        address filterToken,
        uint256 tokensChecked
    );

    /// @notice Operator entry point. Reads `SKIP_FILTER_TOKEN_CHECK` from env (default
    ///         false) and delegates to `runWithFlags`. Splitting the env read out keeps
    ///         tests deterministic — they call `runWithFlags(...)` directly with explicit
    ///         flag values instead of relying on forge's per-test env-isolation behavior,
    ///         which has been observed to silently revert OS env mutations made between
    ///         tests in the same suite.
    function run() external {
        runWithFlags(ScriptUtils.envBool("SKIP_FILTER_TOKEN_CHECK", false));
    }

    /// @notice Pure-flag entry point. Use this from tests; production operators use `run()`.
    function runWithFlags(bool skipFilter) public {
        string memory manifestPath = ScriptUtils.manifestPath();
        require(vm.exists(manifestPath), "VerifySepolia: manifest missing");
        string memory m = vm.readFile(manifestPath);

        // ------------------------------------------------------------ Manifest reads
        address launcherAddr = vm.parseJsonAddress(m, ".addresses.filterLauncher");
        address creatorRegAddr = vm.parseJsonAddress(m, ".addresses.creatorRegistry");
        address tournRegAddr = vm.parseJsonAddress(m, ".addresses.tournamentRegistry");
        address manifestPolMgr = vm.parseJsonAddress(m, ".addresses.polManager");
        address manifestTreasury = vm.parseJsonAddress(m, ".addresses.treasuryTimelock");

        require(launcherAddr != address(0), "VerifySepolia: launcher missing from manifest");
        require(creatorRegAddr != address(0), "VerifySepolia: creatorRegistry missing from manifest");
        require(tournRegAddr != address(0), "VerifySepolia: tournamentRegistry missing from manifest");

        FilterLauncher launcher = FilterLauncher(payable(launcherAddr));
        CreatorRegistry creatorRegistry = CreatorRegistry(creatorRegAddr);
        TournamentRegistry tournamentRegistry = TournamentRegistry(tournRegAddr);

        console2.log("=== VerifySepolia ===");
        console2.log("manifest:        ", manifestPath);
        console2.log("chainId:         ", block.chainid);
        console2.log("filterLauncher:  ", launcherAddr);

        // ------------------------------------------------------------ Assertion 1
        // launcher.launchEscrow() agrees with manifest.launchEscrow (spec §46).
        address manifestEscrow = vm.parseJsonAddress(m, ".addresses.launchEscrow");
        address actualEscrow = address(launcher.launchEscrow());
        if (manifestEscrow == address(0) || actualEscrow == address(0) || actualEscrow != manifestEscrow) {
            console2.log("AssertionFailed_1: launchEscrow mismatch");
            console2.log("  manifest:", manifestEscrow);
            console2.log("  on-chain:", actualEscrow);
            revert("AssertionFailed_1: launcher.launchEscrow != manifest.launchEscrow");
        }
        console2.log("[1/6] launchEscrow OK:", actualEscrow);

        // ------------------------------------------------------------ Assertion 2
        // CreatorRegistry has $FILTER registered. Skippable for pre-seed verifications.
        address filterToken = address(0);
        if (!skipFilter) {
            // Probe `.filterToken.address` defensively — manifest may carry it as a zero
            // address (DeploySepolia placeholder) or as a populated value (post-SeedFilter).
            try vm.parseJsonAddress(m, ".filterToken.address") returns (address addr) {
                filterToken = addr;
            } catch {
                filterToken = address(0);
            }
            if (filterToken == address(0)) {
                revert(
                    "AssertionFailed_2a: manifest.filterToken.address is zero - set SKIP_FILTER_TOKEN_CHECK=1 if pre-seed"
                );
            }
            address filterCreator = creatorRegistry.creatorOf(filterToken);
            if (filterCreator == address(0)) {
                console2.log("AssertionFailed_2b: $FILTER not registered in CreatorRegistry");
                console2.log("  filterToken:", filterToken);
                revert("AssertionFailed_2b: creatorRegistry.creatorOf($FILTER) == address(0)");
            }
            console2.log("[2/6] $FILTER registered, creator:", filterCreator);
        } else {
            console2.log("[2/6] $FILTER check SKIPPED via SKIP_FILTER_TOKEN_CHECK=1");
        }

        // ------------------------------------------------------------ Assertion 3
        // TournamentRegistry.launcher() == FilterLauncher
        address tournLauncher = tournamentRegistry.launcher();
        if (tournLauncher != launcherAddr) {
            console2.log("AssertionFailed_3: tournamentRegistry.launcher mismatch");
            console2.log("  expected:", launcherAddr);
            console2.log("  actual:  ", tournLauncher);
            revert("AssertionFailed_3: tournamentRegistry.launcher != filterLauncher");
        }
        console2.log("[3/6] tournamentRegistry.launcher OK");

        // ------------------------------------------------------------ Assertion 4
        // launcher.polManager() == manifest.polManager AND launcher.treasury() == manifest.treasuryTimelock
        address actualPolMgr = address(launcher.polManager());
        if (actualPolMgr != manifestPolMgr) {
            console2.log("AssertionFailed_4a: launcher.polManager mismatch");
            console2.log("  manifest:", manifestPolMgr);
            console2.log("  on-chain:", actualPolMgr);
            revert("AssertionFailed_4a: launcher.polManager != manifest.polManager");
        }
        address actualTreasury = launcher.treasury();
        if (actualTreasury != manifestTreasury) {
            console2.log("AssertionFailed_4b: launcher.treasury mismatch");
            console2.log("  manifest:", manifestTreasury);
            console2.log("  on-chain:", actualTreasury);
            revert("AssertionFailed_4b: launcher.treasury != manifest.treasuryTimelock");
        }
        console2.log("[4/6] launcher.polManager + treasury match manifest");

        // ------------------------------------------------------------ Assertion 5
        // For every token in the current season: adminOf == creatorOf.
        // adminOf returns creatorOf when no override is set, so this passes by default
        // unless someone has actively run nominateAdmin + acceptAdmin to a different
        // wallet. The check catches half-completed rotations and accidental drift.
        uint256 sid = launcher.currentSeasonId();
        uint256 tokensChecked = 0;
        if (sid == 0) {
            console2.log("[5/6] no season started yet - skipped admin/creator scan");
        } else {
            address[] memory tokens = launcher.tokensInSeason(sid);
            for (uint256 i = 0; i < tokens.length; ++i) {
                address t = tokens[i];
                address admin = creatorRegistry.adminOf(t);
                address creator = creatorRegistry.creatorOf(t);
                if (admin != creator) {
                    console2.log("AssertionFailed_5: admin != creator for token");
                    console2.log("  token:  ", t);
                    console2.log("  creator:", creator);
                    console2.log("  admin:  ", admin);
                    revert("AssertionFailed_5: creatorRegistry.adminOf != creatorOf for at least one token");
                }
                ++tokensChecked;
            }
            console2.log("[5/6] admin == creator for", tokensChecked, "tokens");
        }

        // ------------------------------------------------------------ Assertion 6
        // Spec §4.6.1 protocol blocklist seed. Constructor must have populated all six.
        string[6] memory seedTickers = ["FILTER", "WETH", "ETH", "USDC", "USDT", "DAI"];
        for (uint256 i = 0; i < seedTickers.length; ++i) {
            bytes32 h = keccak256(bytes(seedTickers[i]));
            if (!launcher.tickerBlocklist(h)) {
                console2.log("AssertionFailed_6: blocklist missing seed");
                console2.log("  ticker:", seedTickers[i]);
                revert("AssertionFailed_6: protocol-blocklist seed entry missing");
            }
        }
        console2.log("[6/6] blocklist seed OK (FILTER, WETH, ETH, USDC, USDT, DAI)");

        // ------------------------------------------------------------ Success
        emit VerifySepoliaOK({
            chainId: block.chainid,
            filterLauncher: launcherAddr,
            launchEscrow: actualEscrow,
            filterTokenChecked: !skipFilter,
            filterToken: filterToken,
            tokensChecked: tokensChecked
        });
        console2.log("=== VerifySepoliaOK ===");
    }
}
