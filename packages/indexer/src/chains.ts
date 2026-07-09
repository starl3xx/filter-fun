/// viem chain definitions for Robinhood Chain (2026-07 retarget). Not in
/// `viem/chains` (checked against viem 2.48.x), so defined locally. The web
/// package carries twin literals in `packages/web/src/lib/chains.ts` — small
/// enough to duplicate rather than mint a shared workspace package; keep the
/// two files' values in sync if anything changes.
///
/// Values verified against the live networks 2026-07-09 (chain ids, Multicall3
/// code present on both, Blockscout explorers). Public RPCs are rate-limited —
/// production transports use the Alchemy URLs from env; the defaults here are
/// for casual tooling only.

import {defineChain} from "viem";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {
    default: {http: ["https://rpc.mainnet.chain.robinhood.com"]},
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      apiUrl: "https://robinhoodchain.blockscout.com/api",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  testnet: true,
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {
    default: {http: ["https://rpc.testnet.chain.robinhood.com"]},
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
      apiUrl: "https://explorer.testnet.chain.robinhood.com/api",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});
