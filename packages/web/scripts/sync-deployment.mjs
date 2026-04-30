#!/usr/bin/env node
/// Copy the contract deploy manifest into the web package so addresses are baked into the
/// build. Run after every successful `forge script DeploySepolia`. Safe to run repeatedly.
///
/// Resolution: defaults to `packages/contracts/deployments/base-sepolia.json`. Override
/// with `NETWORK=base` for mainnet, or `MANIFEST=/abs/path.json` to point at an arbitrary
/// file (useful in CI where the manifest is staged elsewhere).

import {copyFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const monorepoRoot = resolve(webRoot, "..", "..");
const network = process.env.NETWORK ?? "base-sepolia";

const source =
  process.env.MANIFEST ??
  resolve(monorepoRoot, "packages", "contracts", "deployments", `${network}.json`);
const dest = resolve(webRoot, "src", "lib", "deployment.json");

if (!existsSync(source)) {
  console.error(`[sync-deployment] manifest not found: ${source}`);
  console.error(`[sync-deployment] run forge script DeploySepolia first.`);
  process.exit(1);
}

copyFileSync(source, dest);
console.log(`[sync-deployment] ${source} → ${dest}`);
