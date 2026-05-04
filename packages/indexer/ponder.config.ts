import {createConfig} from "@ponder/core";
import {http, parseAbiItem} from "viem";

import {BonusDistributorAbi} from "./abis/BonusDistributor";
import {CreatorCommitmentsAbi} from "./abis/CreatorCommitments";
import {CreatorFeeDistributorAbi} from "./abis/CreatorFeeDistributor";
import {FilterFactoryAbi} from "./abis/FilterFactory";
import {FilterLauncherAbi} from "./abis/FilterLauncher";
import {FilterLpLockerAbi} from "./abis/FilterLpLocker";
import {FilterTokenAbi} from "./abis/FilterToken";
import {LaunchEscrowAbi} from "./abis/LaunchEscrow";
import {LauncherStakeAdminAbi} from "./abis/LauncherStakeAdmin";
import {SeasonVaultAbi} from "./abis/SeasonVault";
import {TournamentRegistryAbi} from "./abis/TournamentRegistry";
import {V4PoolManagerAbi} from "./abis/V4PoolManager";
import {readDeployment} from "./src/deployment.js";

/// Pin to one network per indexer instance. Default to baseSepolia for testnet rehearsal —
/// flip to "base" for mainnet via `PONDER_NETWORK=base`. The `readDeployment` helper picks
/// up addresses from the deploy manifest (Epic 1.6) or falls through to env vars.
const network = (process.env.PONDER_NETWORK ?? "baseSepolia") as "base" | "baseSepolia";
const deployment = readDeployment(network);

const startBlock = deployment.deployBlockNumber;
const launcherAddr = deployment.addresses.filterLauncher;
const factoryAddr = deployment.addresses.filterFactory;
const bonusAddr = deployment.addresses.bonusDistributor;
const tournamentRegistryAddr = deployment.addresses.tournamentRegistry;
const creatorCommitmentsAddrEnv = process.env.CREATOR_COMMITMENTS_ADDRESS as
  | `0x${string}`
  | undefined;
const v4PoolManagerAddr = deployment.addresses.v4PoolManager;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
// Epic 1.15a — companion contracts deployed by `FilterLauncher`'s constructor. Manifest
// path is canonical (DeploySepolia reads them off the launcher and writes to manifest);
// env vars `LAUNCH_ESCROW_ADDRESS` / `LAUNCHER_STAKE_ADMIN_ADDRESS` work for env-only
// production deploys without a manifest on disk.
//
// Audit: bugbot M PR #92. Mirror the `creatorCommitmentsAddr` pattern below — an env-var-
// only deploy that DIDN'T set these falls back through `loadFromEnv` which defaults to
// `ZERO_ADDR` (a truthy string), so a naive `??` chain would subscribe Ponder to the
// zero address with no diagnostic. Treat ZERO as "unset" by explicitly checking it
// before accepting the manifest value, so the launcher-addr sentinel + warn log fires.
const launchEscrowAddrEnv = process.env.LAUNCH_ESCROW_ADDRESS as `0x${string}` | undefined;
const launcherStakeAdminAddrEnv = process.env.LAUNCHER_STAKE_ADMIN_ADDRESS as
  | `0x${string}`
  | undefined;
const launchEscrowFromManifest = deployment.addresses.launchEscrow;
const launcherStakeAdminFromManifest = deployment.addresses.launcherStakeAdmin;
const launchEscrowAddr =
  launchEscrowAddrEnv ??
  (launchEscrowFromManifest && launchEscrowFromManifest !== ZERO_ADDR
    ? launchEscrowFromManifest
    : launcherAddr);
const launcherStakeAdminAddr =
  launcherStakeAdminAddrEnv ??
  (launcherStakeAdminFromManifest && launcherStakeAdminFromManifest !== ZERO_ADDR
    ? launcherStakeAdminFromManifest
    : launcherAddr);

console.log(
  `[ponder] indexing ${network} from block ${startBlock} (commit ${deployment.deployCommitHash})`,
);
console.log(`[ponder]   launcher: ${launcherAddr}`);
console.log(`[ponder]   factory:  ${factoryAddr}`);
console.log(`[ponder]   tournament registry: ${tournamentRegistryAddr}`);
console.log(`[ponder]   v4 pool manager:     ${v4PoolManagerAddr}`);
console.log(`[ponder]   launch escrow:       ${launchEscrowAddr}`);
console.log(`[ponder]   stake admin:         ${launcherStakeAdminAddr}`);
if (launchEscrowAddr === launcherAddr) {
  console.warn(
    `[ponder]   launch escrow: <unset in manifest + env> — using launcher addr as a no-op sentinel. Set LAUNCH_ESCROW_ADDRESS or supply a manifest with addresses.launchEscrow populated.`,
  );
}
if (launcherStakeAdminAddr === launcherAddr) {
  console.warn(
    `[ponder]   stake admin: <unset in manifest + env> — using launcher addr as a no-op sentinel. Set LAUNCHER_STAKE_ADMIN_ADDRESS or supply a manifest with addresses.launcherStakeAdmin populated.`,
  );
}

/// `CreatorCommitments` is deployed by `FilterLauncher` in its constructor (the launcher
/// owns it for `setUnlock` / `transferGate` calls). The deploy script reads it back off
/// the launcher and writes it into the manifest's flat `addresses` block, so the manifest
/// path is the canonical source. The env var is kept as an operator override for cases
/// where the manifest isn't on disk (Docker / Railway with a shimmed env-only deploy).
/// Falls back to the launcher's address as a non-functional sentinel if both are unset —
/// the launcher never emits `Committed`, so the subscription is inert in that case (we'd
/// see no rows, not crash).
const creatorCommitmentsFromManifest = deployment.addresses.creatorCommitments;
const creatorCommitmentsAddr =
  creatorCommitmentsAddrEnv ??
  (creatorCommitmentsFromManifest && creatorCommitmentsFromManifest !== ZERO_ADDR
    ? creatorCommitmentsFromManifest
    : launcherAddr);
if (creatorCommitmentsAddr === launcherAddr) {
  console.warn(
    `[ponder]   creator commitments: <unset in manifest + env> — falling back to ${creatorCommitmentsAddr} (no events will match). Set CREATOR_COMMITMENTS_ADDRESS or supply a manifest with addresses.creatorCommitments populated.`,
  );
} else {
  console.log(`[ponder]   creator commitments: ${creatorCommitmentsAddr}`);
}

/// Epic 1.21 / spec §47.4 — CreatorFeeDistributor emits `OperatorActionEmitted` from
/// `disableCreatorFee`. The address is in the manifest at `addresses.creatorFeeDistributor`;
/// fall back to the launcher address as a no-op sentinel when unset (mirrors the
/// CreatorCommitments pattern above).
const creatorFeeDistributorFromManifest = deployment.addresses.creatorFeeDistributor;
const creatorFeeDistributorAddr =
  creatorFeeDistributorFromManifest && creatorFeeDistributorFromManifest !== ZERO_ADDR
    ? creatorFeeDistributorFromManifest
    : launcherAddr;
if (creatorFeeDistributorAddr === launcherAddr) {
  console.warn(
    `[ponder]   creator fee distributor: <unset in manifest> — falling back to ${creatorFeeDistributorAddr} (no events will match). Supply a manifest with addresses.creatorFeeDistributor populated.`,
  );
} else {
  console.log(`[ponder]   creator fee distributor: ${creatorFeeDistributorAddr}`);
}

/// Indexes the canonical filter.fun deployment. `SeasonVault`, `FilterLpLocker`, and
/// `FilterToken` are deployed dynamically per launch — Ponder's factory pattern picks them
/// up via the parent contract's emit log.
export default createConfig({
  networks: {
    base: {
      chainId: 8453,
      transport: http(process.env.PONDER_RPC_URL_8453),
    },
    baseSepolia: {
      chainId: 84532,
      transport: http(process.env.PONDER_RPC_URL_84532),
    },
  },
  contracts: {
    FilterLauncher: {
      network,
      abi: FilterLauncherAbi,
      address: launcherAddr,
      startBlock,
    },
    FilterFactory: {
      network,
      abi: FilterFactoryAbi,
      address: factoryAddr,
      startBlock,
    },
    BonusDistributor: {
      network,
      abi: BonusDistributorAbi,
      address: bonusAddr,
      startBlock,
    },
    /// Epic 1.15a — escrow holds creator slot stakes between reservation and activation.
    /// Emits SlotReserved / ReservationReleased / ReservationRefunded / RefundFailed /
    /// PendingRefundClaimed / SeasonAborted. We index all six to drive the Arena
    /// reservation lifecycle UI + per-creator pending-refund claim flow.
    LaunchEscrow: {
      network,
      abi: LaunchEscrowAbi,
      address: launchEscrowAddr,
      startBlock,
    },
    /// Epic 1.15a — stake admin holds soft-filter / activation accounting and emits
    /// StakeRefunded / StakeForfeited when slots clear after activation.
    LauncherStakeAdmin: {
      network,
      abi: LauncherStakeAdminAbi,
      address: launcherStakeAdminAddr,
      startBlock,
    },
    SeasonVault: {
      network,
      abi: SeasonVaultAbi,
      factory: {
        address: launcherAddr,
        // Topic0 is keccak256 of the full event signature including ALL parameters, even
        // unindexed ones. The launcher emits 4 args here (seasonId/vault/launchStartTime/
        // launchEndTime). A 2-arg parseAbiItem hashes to a different topic0 — Ponder's
        // factory pattern would never match new logs, no SeasonVault child contracts
        // would be discovered, and every vault-side handler (WinnerSubmitted / Liquidated
        // / Finalized / RolloverClaimed) would silently never fire. (Bugbot caught this
        // when sync-abis pulled in the new contract signature without the matching
        // ponder.config.ts update.)
        event: parseAbiItem(
          "event SeasonStarted(uint256 indexed seasonId, address vault, uint256 launchStartTime, uint256 launchEndTime)",
        ),
        parameter: "vault",
      },
      startBlock,
    },
    FilterLpLocker: {
      network,
      abi: FilterLpLockerAbi,
      factory: {
        address: factoryAddr,
        event: parseAbiItem(
          "event TokenDeployed(address indexed token, address indexed locker, bytes32 poolId, address creator)",
        ),
        parameter: "locker",
      },
      startBlock,
    },
    FilterToken: {
      network,
      abi: FilterTokenAbi,
      factory: {
        address: factoryAddr,
        event: parseAbiItem(
          "event TokenDeployed(address indexed token, address indexed locker, bytes32 poolId, address creator)",
        ),
        parameter: "token",
      },
      startBlock,
    },
    CreatorCommitments: {
      network,
      abi: CreatorCommitmentsAbi,
      address: creatorCommitmentsAddr,
      startBlock,
    },
    TournamentRegistry: {
      network,
      abi: TournamentRegistryAbi,
      address: tournamentRegistryAddr,
      startBlock,
    },
    /// Singleton creator-fee distributor.
    /// - Epic 1.16: per-token Accrued / Redirected / Claimed / Disabled events feed
    ///   the `creatorEarning` rollup so `lifetimeAccrued`, `claimable`, and
    ///   `lastClaimAt` resolve in O(1).
    /// - Epic 1.21 / spec §47.4: `OperatorActionEmitted` from `disableCreatorFee`
    ///   mirrors into `operatorActionLog` for the operator-console audit view.
    CreatorFeeDistributor: {
      network,
      abi: CreatorFeeDistributorAbi,
      address: creatorFeeDistributorAddr,
      startBlock,
    },
    /// V4 PoolManager is the singleton emitter for every `Swap` on Base. We index ALL its
    /// Swap events and filter to filter.fun pools at the handler boundary by joining
    /// `Swap.id` against our `pool` table (populated from `FilterFactory.TokenDeployed`).
    /// On a busy chain this is wasteful; the eventual fix is a topic-based filter once we
    /// can enumerate poolIds at config time. Acceptable for genesis where the indexer
    /// starts at our deploy block.
    V4PoolManager: {
      network,
      abi: V4PoolManagerAbi,
      address: v4PoolManagerAddr,
      startBlock,
    },
  },
  /// Periodic block filter that drives `hpSnapshot` writes. The handler computes the
  /// current cohort's HP+components and inserts a snapshot row per token, building the
  /// timeseries that backs `/tokens/:address/history`. Default interval = 150 blocks
  /// (≈5 min on Base's 2s blocks). Override via `HP_SNAPSHOT_INTERVAL_BLOCKS` to thin
  /// the series down for cheaper testnet runs (or thicken it for backtesting).
  blocks: {
    HpSnapshot: {
      network,
      startBlock,
      interval: Number(process.env.HP_SNAPSHOT_INTERVAL_BLOCKS ?? 150),
    },
  },
});
