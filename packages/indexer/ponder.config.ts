import {createConfig} from "@ponder/core";
import {http, parseAbiItem} from "viem";

import {FilterLauncherAbi} from "./abis/FilterLauncher";
import {FilterLpLockerAbi} from "./abis/FilterLpLocker";
import {SeasonVaultAbi} from "./abis/SeasonVault";
import {BonusDistributorAbi} from "./abis/BonusDistributor";

const startBlock = Number(process.env.DEPLOY_BLOCK ?? 0);
const launcherAddr = (process.env.FILTER_LAUNCHER_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
const factoryAddr = (process.env.FILTER_FACTORY_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
const bonusAddr = (process.env.BONUS_DISTRIBUTOR_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;

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
      network: "base",
      abi: FilterLauncherAbi,
      address: launcherAddr,
      startBlock,
    },
    BonusDistributor: {
      network: "base",
      abi: BonusDistributorAbi,
      address: bonusAddr,
      startBlock,
    },
    SeasonVault: {
      network: "base",
      abi: SeasonVaultAbi,
      factory: {
        address: launcherAddr,
        event: parseAbiItem("event SeasonStarted(uint256 indexed seasonId, address vault)"),
        parameter: "vault",
      },
      startBlock,
    },
    FilterLpLocker: {
      network: "base",
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
