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
//
// 2026-07 Robinhood retarget: the Robinhood chains are NOT added to this
// import — viem 2.48.x doesn't ship them, and even once it does they must
// keep coming from the local `./chains.ts` literals so this line stays
// byte-identical and the tree-shake pin in `polishPerfPass.test.tsx`
// keeps holding (it asserts exactly `{base, baseSepolia}` here AND that
// robinhood/robinhoodTestnet come from "./chains").
import {base, baseSepolia} from "wagmi/chains";
import {coinbaseWallet, injected, walletConnect} from "wagmi/connectors";

// `deploymentMeta` is no longer read here — the env-vs-manifest resolution
// (including the manifest fallback) moved wholesale into
// `chain.ts#activeChainSlug` so every surface resolves the same slug.
import {activeChainSlug, type ChainSlug} from "./chain.js";
import {robinhood, robinhoodTestnet} from "./chains.js";

/// Chain selection (2026-07 Robinhood retarget — widened from the binary
/// base/base-sepolia ternary to the four-slug map below). Resolution order
/// is unchanged and lives in `chain.ts#activeChainSlug`:
///   1. NEXT_PUBLIC_CHAIN env override (explicit op-set).
///   2. The deployment manifest's `network` field (synced via `npm run sync:deployment`).
///   3. "robinhood-testnet" default (testnet rehearsal target; was
///      "base-sepolia" pre-retarget).
///
/// The `||`-not-`??` Docker empty-string rationale (bugbot, PR #86) moved to
/// `chain.ts` with the resolution logic — see `activeChainSlug`.
///
/// A stale committed manifest (`network: "base-sepolia"`) alongside
/// NEXT_PUBLIC_CHAIN=robinhood-testnet resolves to robinhood-testnet — env
/// wins, same as it always has. The manifest network only matters when the
/// env override is absent/empty.
const chainSlug: ChainSlug = activeChainSlug();
const CHAIN_BY_SLUG = {
  base,
  "base-sepolia": baseSepolia,
  robinhood,
  "robinhood-testnet": robinhoodTestnet,
} as const;
const chain = CHAIN_BY_SLUG[chainSlug];

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
// 2026-07 Robinhood retarget: the env-name/env-value pair generalizes from
// the base/base-sepolia ternary to one entry per ChainSlug. The values map
// reads each `process.env.NEXT_PUBLIC_*` var as a LITERAL property access —
// Next.js's webpack DefinePlugin only inlines statically-written
// `process.env.NEXT_PUBLIC_*` expressions, so a dynamic
// `process.env[name]` lookup would silently read `undefined` in the browser
// bundle and defeat the warning below.
const RPC_ENV_NAME_BY_SLUG: Record<ChainSlug, string> = {
  base: "NEXT_PUBLIC_BASE_RPC_URL",
  "base-sepolia": "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
  robinhood: "NEXT_PUBLIC_ROBINHOOD_RPC_URL",
  "robinhood-testnet": "NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL",
};
const RPC_URL_BY_SLUG: Record<ChainSlug, string | undefined> = {
  base: process.env.NEXT_PUBLIC_BASE_RPC_URL,
  "base-sepolia": process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
  robinhood: process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL,
  "robinhood-testnet": process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL,
};
const expectedRpcEnvName = RPC_ENV_NAME_BY_SLUG[chainSlug];
const expectedRpcUrl = RPC_URL_BY_SLUG[chainSlug];
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
    // `|| undefined` matches the Base entries' empty-string semantics: an
    // unset Docker ARG bakes `""` into the bundle, and viem's http()
    // falsy-coalesces to the chain's default (rate-limited) public RPC —
    // the soft-fail path the module-load warning above already covers.
    [robinhood.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || undefined),
    [robinhoodTestnet.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL || undefined),
  },
  ssr: true,
});

export {chain};
