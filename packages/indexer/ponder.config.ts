import {createConfig} from "@ponder/core";
import {http, parseAbiItem} from "viem";

import {BonusDistributorAbi} from "./abis/BonusDistributor";
import {CreatorCommitmentsAbi} from "./abis/CreatorCommitments";
import {FilterFactoryAbi} from "./abis/FilterFactory";
import {FilterLauncherAbi} from "./abis/FilterLauncher";
import {FilterLpLockerAbi} from "./abis/FilterLpLocker";
import {FilterTokenAbi} from "./abis/FilterToken";
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

console.log(
  `[ponder] indexing ${network} from block ${startBlock} (commit ${deployment.deployCommitHash})`,
);
console.log(`[ponder]   launcher: ${launcherAddr}`);
console.log(`[ponder]   factory:  ${factoryAddr}`);
console.log(`[ponder]   tournament registry: ${tournamentRegistryAddr}`);
console.log(`[ponder]   v4 pool manager:     ${v4PoolManagerAddr}`);

/// `CreatorCommitments` is deployed by `FilterLauncher` in its constructor, so the address
/// isn't on the deploy manifest's flat `addresses` block (it lives in the launcher's
/// constructor args / runtime view). For now the operator surfaces it via env var so the
/// indexer can subscribe to its `Committed` events; the eventual wiring is to extend the
/// deploy manifest writer with this address. Falls back to the launcher's address as a
/// non-functional sentinel if missing — the launcher never emits `Committed`, so the
/// subscription is inert in that case (we'd see no rows, not crash).
const creatorCommitmentsAddr = creatorCommitmentsAddrEnv ?? launcherAddr;
if (!creatorCommitmentsAddrEnv) {
  console.warn(
    `[ponder]   creator commitments: <unset, set CREATOR_COMMITMENTS_ADDRESS> — falling back to ${creatorCommitmentsAddr} (no events will match)`,
  );
} else {
  console.log(`[ponder]   creator commitments: ${creatorCommitmentsAddr}`);
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
