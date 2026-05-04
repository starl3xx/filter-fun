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
  /// CreatorCommitments — the on-chain bag-lock primitive (Epic 1.13). Address
  /// arrives via the same deploy manifest sync; pre-deploy it's the zero
  /// address and `isDeployed("creatorCommitments")` gates the bag-lock UI.
  creatorCommitments: (deployment.addresses.creatorCommitments || ZERO_ADDR) as Address,
  /// CreatorFeeDistributor — Epic 1.21 / spec §47.4.2. Operator console calls
  /// `disableCreatorFee(token, reason)` here for sanctioned/compromised creator
  /// addresses. Pre-deploy it's the zero address; `isDeployed("creatorFeeDistributor")`
  /// gates the form.
  creatorFeeDistributor: (deployment.addresses.creatorFeeDistributor || ZERO_ADDR) as Address,
  // `filterToken` is intentionally not exported here. The deploy manifest
  // stores it at the top level as an object `{address, locker, ...}` (set
  // by SeedFilter.s.sol after the protocol launch), not under `addresses.*`.
  // Re-add when something in the web app actually needs it, with the correct
  // path: `(deployment as {filterToken?: {address?: string}}).filterToken?.address`.
} as const;

/// True iff the deploy manifest carries a real address for `name`. Use to
/// gate UI that depends on contract calls; pre-deploy the manifest holds
/// zero addresses and `useReadContract` would otherwise just spin.
export function isDeployed(name: keyof typeof contractAddresses): boolean {
  return contractAddresses[name] !== ZERO_ADDR;
}
