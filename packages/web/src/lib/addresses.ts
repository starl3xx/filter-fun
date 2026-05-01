/// Deployment metadata for the web app. Sourced from the deploy manifest copied in at
/// build time via `scripts/sync-deployment.mjs`.

import type {Address} from "viem";

import deployment from "./deployment.json" assert {type: "json"};

export const deploymentMeta = {
  network: deployment.network,
  chainId: deployment.chainId,
  deployBlockNumber: deployment.deployBlockNumber,
  deployCommitHash: deployment.deployCommitHash,
} as const;

const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";

export const contractAddresses = {
  filterLauncher: (deployment.addresses.filterLauncher || ZERO_ADDR) as Address,
  filterFactory: (deployment.addresses.filterFactory || ZERO_ADDR) as Address,
  filterToken: ((deployment as {filterToken?: string}).filterToken || ZERO_ADDR) as Address,
} as const;

/// True iff the deploy manifest carries a real address for `name`. Use to
/// gate UI that depends on contract calls; pre-deploy the manifest holds
/// zero addresses and `useReadContract` would otherwise just spin.
export function isDeployed(name: keyof typeof contractAddresses): boolean {
  return contractAddresses[name] !== ZERO_ADDR;
}
