import {createConfig} from "@ponder/core";
import {http, parseAbiItem} from "viem";

import {FilterLauncherAbi} from "./abis/FilterLauncher";
import {FilterLpLockerAbi} from "./abis/FilterLpLocker";
import {SeasonVaultAbi} from "./abis/SeasonVault";
import {BonusDistributorAbi} from "./abis/BonusDistributor";
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

console.log(
  `[ponder] indexing ${network} from block ${startBlock} (commit ${deployment.deployCommitHash})`,
);
console.log(`[ponder]   launcher: ${launcherAddr}`);
console.log(`[ponder]   factory:  ${factoryAddr}`);

/// Indexes the canonical filter.fun deployment. `SeasonVault` and `FilterLpLocker` are deployed
/// dynamically — Ponder's factory pattern picks them up via the parent contract's emit log.
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
        event: parseAbiItem("event SeasonStarted(uint256 indexed seasonId, address vault)"),
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
  },
});
