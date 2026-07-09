/// Chain-slug vocabulary + link helpers (2026-07 Robinhood Chain retarget).
///
/// Single home for the "which network are we on?" question. Before this
/// module the slug union `"base" | "base-sepolia"` was inlined at ~12 call
/// sites and every explorer / trade link re-derived its host with a local
/// ternary — fine for two chains, unmaintainable for four. This is an
/// EXTEND-don't-delete retarget: the Base slugs stay fully supported as the
/// retreat path; the defaults flip to Robinhood.
///
/// The viem chain OBJECTS live elsewhere (`wagmi/chains` for Base,
/// `./chains.ts` for Robinhood — see the M-Perf-1 tree-shake note there).
/// This module is deliberately UI-shaped: slugs, labels, and URLs only, so
/// components can import it without dragging wagmi into their module graph.

import {deploymentMeta} from "./addresses.js";

export type ChainSlug = "base" | "base-sepolia" | "robinhood" | "robinhood-testnet";

/// Default network when neither the env override nor the deploy manifest
/// yields a recognized slug. Flipped from "base-sepolia" to
/// "robinhood-testnet" in the 2026-07 retarget — testnet rehearsal target.
const DEFAULT_CHAIN_SLUG: ChainSlug = "robinhood-testnet";

/// Normalize a raw network string (env var, deploy-manifest `network` field)
/// into a `ChainSlug`. Accepts the four canonical kebab-case slugs plus the
/// camelCase variants ("baseSepolia" / "robinhoodTestnet") that Foundry
/// deploy-manifest tooling has historically emitted. Anything else —
/// including `undefined` and the Docker empty-string case — falls through to
/// `DEFAULT_CHAIN_SLUG`, preserving the pre-retarget "unknown means testnet"
/// behavior (just retargeted).
export function normalizeChainSlug(value: string | null | undefined): ChainSlug {
  switch (value) {
    case "base":
      return "base";
    case "base-sepolia":
    case "baseSepolia":
      return "base-sepolia";
    case "robinhood":
      return "robinhood";
    case "robinhood-testnet":
    case "robinhoodTestnet":
      return "robinhood-testnet";
    default:
      return DEFAULT_CHAIN_SLUG;
  }
}

/// The app-wide active chain slug. Resolution order (unchanged from the
/// original `wagmi.ts` rule, widened to four slugs):
///   1. NEXT_PUBLIC_CHAIN env override (explicit op-set).
///   2. The deployment manifest's `network` field (synced via
///      `npm run sync:deployment`).
///   3. "robinhood-testnet" default (testnet rehearsal target).
///
/// Use `||` not `??` (bugbot caught on PR #86): with the Docker ARG / ENV
/// pattern that forwards Railway env vars into the build, an unset ARG still
/// produces an empty string `""` (not `undefined`) in
/// `process.env.NEXT_PUBLIC_CHAIN`, which Next.js inlines into the bundle.
/// `"" ?? fallback` evaluates to `""` because `??` only catches
/// null/undefined — that would silently force the default chain even when
/// the deployment manifest names a network. `""`-aware `||` makes the
/// deployment-manifest fallback work for both "not set anywhere"
/// (undefined, dev) and "declared as ARG without --build-arg" (empty
/// string, Docker).
///
/// Pre-retarget, the arena / admin pages read NEXT_PUBLIC_CHAIN directly and
/// silently ignored the manifest, so an env-less mainnet manifest rendered
/// testnet explorer links while wagmi connected to mainnet. Centralizing on
/// this helper closes that drift: every surface now resolves the same slug
/// wagmi actually connects with.
export function activeChainSlug(): ChainSlug {
  return normalizeChainSlug(process.env.NEXT_PUBLIC_CHAIN || deploymentMeta.network);
}

export function isTestnet(slug: ChainSlug): boolean {
  return slug === "base-sepolia" || slug === "robinhood-testnet";
}

/// Chain badge copy (TokenHeader et al). "· V4" because every deployment
/// target runs the same Uniswap-V4-hooked stack (see
/// `architecture_v4_liquid` — own factory/hook/LP-locker).
export function chainLabel(slug: ChainSlug): string {
  switch (slug) {
    case "robinhood":
      return "Robinhood · V4";
    case "robinhood-testnet":
      return "Robinhood Testnet · V4";
    case "base":
      return "Base · V4";
    case "base-sepolia":
      return "Base Sepolia · V4";
  }
}

/// Explorer metadata per slug. Robinhood runs Blockscout (verified live
/// 2026-07-09); Base keeps Basescan (Etherscan-family). Both families share
/// the `/tx/`, `/token/`, and `/address/` path shapes, so the URL builders
/// below need no per-family branching.
const EXPLORERS: Record<ChainSlug, {host: string; name: string}> = {
  robinhood: {host: "https://robinhoodchain.blockscout.com", name: "Blockscout"},
  "robinhood-testnet": {host: "https://explorer.testnet.chain.robinhood.com", name: "Blockscout"},
  base: {host: "https://basescan.org", name: "Basescan"},
  "base-sepolia": {host: "https://sepolia.basescan.org", name: "Basescan"},
};

/// Human name of the chain's explorer — for link labels ("View on Basescan"
/// / "View on Blockscout"), never for URL construction.
export function explorerName(slug: ChainSlug): string {
  return EXPLORERS[slug].name;
}

export function explorerTxUrl(slug: ChainSlug, hash: string): string {
  return `${EXPLORERS[slug].host}/tx/${hash}`;
}

export function explorerTokenUrl(slug: ChainSlug, address: string): string {
  return `${EXPLORERS[slug].host}/token/${address}`;
}

export function explorerAddressUrl(slug: ChainSlug, address: string): string {
  return `${EXPLORERS[slug].host}/address/${address}`;
}
