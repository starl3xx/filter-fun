/// Loads the deployment manifest produced by `packages/contracts/script/DeploySepolia.s.sol`
/// (and, eventually, the matching mainnet deploy) and exposes a flat `Deployment` record
/// that the Ponder config + API server consume.
///
/// Resolution order:
///   1. `DEPLOYMENT_MANIFEST_PATH` env — explicit path. Wins when set. Useful for Docker /
///      Railway deploys where the indexer image doesn't have the monorepo on disk and the
///      operator mounts the manifest at a known location.
///   2. Monorepo default — `../contracts/deployments/<network>.json`. The dev path: works
///      out of the box with `npm run dev` after `forge script DeploySepolia`.
///   3. Env-var fallback — `FILTER_LAUNCHER_ADDRESS` / `FILTER_FACTORY_ADDRESS` /
///      `BONUS_DISTRIBUTOR_ADDRESS` / `DEPLOY_BLOCK`. Preserves the pre-Epic-1.6 contract
///      so existing mainnet deploys keep working without a manifest.
///
/// Strict mode: when `DEPLOYMENT_MANIFEST_REQUIRED=1`, falling through to the env-var
/// fallback throws — the indexer refuses to start with a partially-configured deployment.

import {readFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

export type ChainNetwork = "base" | "baseSepolia";

export interface DeploymentAddresses {
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

export interface Deployment {
  /// "base" or "baseSepolia" — keyed off the manifest's `network` field, normalized to the
  /// camelCase variant the Ponder config + wagmi config use.
  network: ChainNetwork;
  /// Block height the manifest was written at — Ponder uses this as `startBlock` for every
  /// indexed contract. Without this, Ponder reindexes from chain genesis (slow, expensive,
  /// and pointless since the contracts didn't exist before this block).
  deployBlockNumber: number;
  /// Git commit the deployed bytecode was built from. Logged at indexer start so a
  /// production indexer that's pointed at the wrong manifest is obvious in the boot log.
  deployCommitHash: string;
  addresses: DeploymentAddresses;
}

interface RawManifest {
  chainId: number;
  network: string; // "base-sepolia" | "base"
  deployBlockNumber: number;
  deployedAt: number;
  deployCommitHash: string;
  deployerAddress: `0x${string}`;
  hookSalt: string;
  filterToken?: string | {address: `0x${string}`; locker: `0x${string}`};
  addresses: DeploymentAddresses;
  config: Record<string, unknown>;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/// Default to base-sepolia when ambiguous — that's the testnet rehearsal target. Mainnet
/// deploys override via `PONDER_NETWORK=base`.
export function readDeployment(networkHint?: ChainNetwork): Deployment {
  const network: ChainNetwork = networkHint ?? (process.env.PONDER_NETWORK as ChainNetwork) ?? "baseSepolia";

  const fromManifest = tryLoadManifest(network);
  if (fromManifest) return fromManifest;

  if (process.env.DEPLOYMENT_MANIFEST_REQUIRED === "1") {
    throw new Error(
      `[indexer] manifest required but not found. Set DEPLOYMENT_MANIFEST_PATH or place ` +
        `the manifest at packages/contracts/deployments/${networkSlug(network)}.json.`,
    );
  }

  return loadFromEnv(network);
}

function tryLoadManifest(network: ChainNetwork): Deployment | null {
  const candidates: string[] = [];
  if (process.env.DEPLOYMENT_MANIFEST_PATH) candidates.push(process.env.DEPLOYMENT_MANIFEST_PATH);
  candidates.push(monorepoManifestPath(network));

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as RawManifest;
      // Sanity check: refuse a manifest that points at a different network than asked for —
      // an indexer pointed at base-mainnet would otherwise silently load the testnet
      // manifest if the operator forgot to set DEPLOYMENT_MANIFEST_PATH.
      const manifestNetwork = normalizeNetwork(raw.network);
      if (manifestNetwork !== network) {
        // Don't throw — caller may have multiple manifests on disk and expects path
        // resolution to filter; but skip this candidate.
        continue;
      }
      return {
        network: manifestNetwork,
        deployBlockNumber: raw.deployBlockNumber,
        deployCommitHash: raw.deployCommitHash,
        addresses: raw.addresses,
      };
    } catch (e) {
      // Treat malformed JSON as "manifest not present" rather than throwing — the env-var
      // fallback may still be valid.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[indexer] failed to parse manifest at ${p}: ${msg}`);
    }
  }
  return null;
}

function loadFromEnv(network: ChainNetwork): Deployment {
  const launcher = (process.env.FILTER_LAUNCHER_ADDRESS ?? ZERO) as `0x${string}`;
  const factory = (process.env.FILTER_FACTORY_ADDRESS ?? ZERO) as `0x${string}`;
  const bonus = (process.env.BONUS_DISTRIBUTOR_ADDRESS ?? ZERO) as `0x${string}`;
  return {
    network,
    deployBlockNumber: Number(process.env.DEPLOY_BLOCK ?? 0),
    deployCommitHash: process.env.DEPLOY_COMMIT_HASH ?? "unknown",
    addresses: {
      treasuryTimelock: ZERO,
      bonusDistributor: bonus,
      polVault: ZERO,
      filterLauncher: launcher,
      polManager: ZERO,
      filterHook: ZERO,
      filterFactory: factory,
      creatorRegistry: ZERO,
      creatorFeeDistributor: ZERO,
      tournamentRegistry: ZERO,
      tournamentVault: ZERO,
      v4PoolManager: ZERO,
      weth: ZERO,
    },
  };
}

function monorepoManifestPath(network: ChainNetwork): string {
  // `import.meta.url` resolves to this file inside the indexer package. Walk up to the
  // monorepo root and across to the contracts package's `deployments/` directory. Survives
  // `npm run dev` (ESM) and the bundled production indexer alike.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "contracts", "deployments", `${networkSlug(network)}.json`);
}

function networkSlug(network: ChainNetwork): string {
  return network === "baseSepolia" ? "base-sepolia" : "base";
}

function normalizeNetwork(s: string): ChainNetwork {
  if (s === "base-sepolia" || s === "baseSepolia") return "baseSepolia";
  if (s === "base" || s === "base-mainnet") return "base";
  throw new Error(`[indexer] unknown manifest network: ${s}`);
}
