import {http, createConfig} from "wagmi";
import {base, baseSepolia} from "wagmi/chains";
import {coinbaseWallet, injected, walletConnect} from "wagmi/connectors";

import {deploymentMeta} from "./addresses.js";

/// Chain selection. Resolution order:
///   1. NEXT_PUBLIC_CHAIN env override (explicit op-set).
///   2. The deployment manifest's `network` field (synced via `npm run sync:deployment`).
///   3. base-sepolia default (testnet rehearsal target).
const chainName =
  process.env.NEXT_PUBLIC_CHAIN ??
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
// dapp bugs to the user. Detect the missing-env case at module load and:
//   - throw in production builds (deploy-time fail-fast — a missing env var
//     is an ops misconfig, not a runtime condition the app should tolerate);
//   - warn in dev / test where falling back to the public RPC is the
//     intended developer-friction-free behaviour and the test suite must
//     keep importing this module without provisioning real RPCs.
const expectedRpcEnvName: "NEXT_PUBLIC_BASE_RPC_URL" | "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL" =
  chain === base ? "NEXT_PUBLIC_BASE_RPC_URL" : "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL";
const expectedRpcUrl =
  chain === base
    ? process.env.NEXT_PUBLIC_BASE_RPC_URL
    : process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL;
if (!expectedRpcUrl || expectedRpcUrl.trim() === "") {
  const message = `[wagmi] ${expectedRpcEnvName} is unset for active chain "${chain.name}" — viem will fall back to the rate-limited public RPC and reads/txs will silently fail under load.`;
  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
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
