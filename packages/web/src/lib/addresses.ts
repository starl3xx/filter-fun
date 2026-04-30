/// Deployment metadata for the web app. Sourced from the deploy manifest copied in at
/// build time via `scripts/sync-deployment.mjs`. Currently only `deploymentMeta` is consumed
/// (by `wagmi.ts`); contract address re-exports + `isDeployed()` will land here when the
/// first consumer needs them — keeping unused public API out for now.

import deployment from "./deployment.json" assert {type: "json"};

export const deploymentMeta = {
  network: deployment.network,
  chainId: deployment.chainId,
  deployBlockNumber: deployment.deployBlockNumber,
  deployCommitHash: deployment.deployCommitHash,
} as const;
