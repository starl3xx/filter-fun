import {http, createConfig} from "wagmi";
// Audit M-Perf-1 (Phase 1, 2026-05-03): the `wagmi/chains` re-export wraps
// viem's chain registry, which ships definitions for 900+ chains. We import
// only `base` (chainId 8453) and `baseSepolia` (chainId 84532) — verified
// post-`next build` that the production bundle contains exactly ONE chunk
// referencing those chain ids and ZERO chunks referencing other chains'
// ids (Ethereum mainnet=1, Polygon=137, Optimism=10, BSC=56, Avalanche=43114
// all absent). The Next.js / webpack tree-shake correctly elides the
// rest of the registry. Do NOT switch to `import * from "wagmi/chains"`
// or destructure into a `chains` const — both would defeat the
// tree-shake and pull the full registry into First Load JS. The narrow
// named-import form here is the spec-correct shape.
import {base, baseSepolia} from "wagmi/chains";
import {coinbaseWallet, injected, walletConnect} from "wagmi/connectors";

import {deploymentMeta} from "./addresses.js";

/// Chain selection. Resolution order:
///   1. NEXT_PUBLIC_CHAIN env override (explicit op-set).
///   2. The deployment manifest's `network` field (synced via `npm run sync:deployment`).
///   3. base-sepolia default (testnet rehearsal target).
///
/// Use `||` not `??` (bugbot caught on PR #86): with the Docker ARG /
/// ENV pattern that forwards Railway env vars into the build, an unset
/// ARG still produces an empty string `""` (not `undefined`) in
/// `process.env.NEXT_PUBLIC_CHAIN`, which Next.js inlines into the bundle.
/// `"" ?? fallback` evaluates to `""` because `??` only catches null /
/// undefined — that would silently force the chain to base-sepolia even
/// when the deployment manifest says "base", flipping a mainnet build
/// to testnet. `""`-aware `||` makes the deployment-manifest fallback
/// work for both "not set anywhere" (undefined, dev) and "declared as
/// ARG without --build-arg" (empty string, Docker).
const chainName =
  process.env.NEXT_PUBLIC_CHAIN ||
  (deploymentMeta.network === "base" ? "base" : "base-sepolia");
const chain = chainName === "base" ? base : baseSepolia;

/// Connector ordering — desktop default first, mobile last.
///   1. injected() — MetaMask / Rabby / Brave / etc; the desktop default.
///   2. coinbaseWallet() — large Base userbase; second-most-likely click.
///   3. walletConnect() — Rainbow / Trust / etc via WC v2 QR pairing.
///
/// Audit H-Web-1 (Phase 1, 2026-05-01): pre-fix only `injected()` was wired,
/// silently excluding Coinbase Wallet (a stated target wallet) and every
/// WalletConnect-based mobile wallet. The connectors below restore production
/// wallet coverage; the connector list is pinned by `wagmiConnectors.test.ts`.
///
/// `NEXT_PUBLIC_WC_PROJECT_ID` must be provisioned via cloud.walletconnect.com
/// before the WalletConnect connector can pair. Without it, WC degrades to
/// silent failure at pair-time — the connector still mounts in the wallet
/// modal but `connect()` rejects. The fallback `""` keeps the module load
/// non-throwing in dev / preview where WC isn't required; production deploys
/// must set the env var. Documented in `packages/web/.env.example`.
const wcProjectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";

// Audit M-Web-8 (Phase 1, 2026-05-02): the active chain's RPC env var is a
// production load-bearing input. Pre-fix `http(undefined)` silently fell back
// to viem's hard-coded public RPC, which is severely rate-limited and
// produces sporadic UX failures (failed reads, stalled txs) that look like
// dapp bugs to the user. Detect the missing-env case at module load and warn
// loudly so ops sees it.
//
// Production incident (2026-05-03): the original M-Web-8 implementation
// `throw`-ed in production. The "deploy-time fail-fast" intent was wrong:
// the throw runs at MODULE-LOAD time, which means it fires in EVERY
// visitor's browser and in EVERY SSR request — turning a missing env var
// from "silent rate limits" (annoying) into "Application error: client-
// side exception" on every page load (catastrophic). Cloudflare CDN
// caches the broken bundle, making recovery slow even after the env
// var is restored.
//
// New shape: always log loudly (so the missing env shows up in browser
// console + Railway server logs), but never throw. viem's public-RPC
// fallback is a strictly better failure mode than "no site at all" —
// users get rate-limited reads instead of a broken page, and ops sees
// the warn in logs and can fix it. The "fail-fast" objective is now
// served by the dev-time .env.example documentation + the build-step
// deploy hooks, not by a runtime throw that takes the whole site down.
const expectedRpcEnvName: "NEXT_PUBLIC_BASE_RPC_URL" | "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL" =
  chain === base ? "NEXT_PUBLIC_BASE_RPC_URL" : "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL";
const expectedRpcUrl =
  chain === base
    ? process.env.NEXT_PUBLIC_BASE_RPC_URL
    : process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL;
if (!expectedRpcUrl || expectedRpcUrl.trim() === "") {
  const message = `[wagmi] ${expectedRpcEnvName} is unset for active chain "${chain.name}" — viem will fall back to the rate-limited public RPC and reads/txs will silently fail under load.`;
  // eslint-disable-next-line no-console
  console.warn(message);
}

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    injected(),
    coinbaseWallet({appName: "filter.fun"}),
    walletConnect({projectId: wcProjectId}),
  ],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL),
  },
  ssr: true,
});

export {chain};
