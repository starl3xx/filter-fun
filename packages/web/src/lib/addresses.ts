/// Contract address registry for the web app. Sourced from the deploy manifest copied in
/// at build time via `scripts/sync-deployment.mjs`.
///
/// Pre-deploy, every address is the zero address. Calls to contracts whose address is zero
/// will obviously fail at the wallet/RPC layer — that's the intended behavior in dev: don't
/// silently pretend a contract exists.

import deployment from "./deployment.json" assert {type: "json"};

export type ContractName = keyof typeof deployment.addresses;

export interface Addresses {
  treasuryTimelock: `0x${string}`;
  bonusDistributor: `0x${string}`;
  polVault: `0x${string}`;
  filterLauncher: `0x${string}`;
  polManager: `0x${string}`;
  filterHook: `0x${string}`;
  filterFactory: `0x${string}`;
  creatorRegistry: `0x${string}`;
  creatorFeeDistributor: `0x${string}`;
  tournamentRegistry: `0x${string}`;
  tournamentVault: `0x${string}`;
  v4PoolManager: `0x${string}`;
  weth: `0x${string}`;
}

export const addresses: Addresses = deployment.addresses as Addresses;

export const deploymentMeta = {
  network: deployment.network,
  chainId: deployment.chainId,
  deployBlockNumber: deployment.deployBlockNumber,
  deployCommitHash: deployment.deployCommitHash,
} as const;

/// Convenience guard for "do we have a real deploy yet?". Used by the seed-page UI to swap
/// real-deploy controls for a "deploy first" placeholder during local dev.
export function isDeployed(): boolean {
  return addresses.filterLauncher !== "0x0000000000000000000000000000000000000000";
}
