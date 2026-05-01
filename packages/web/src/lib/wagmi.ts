import {http, createConfig} from "wagmi";
import {base, baseSepolia} from "wagmi/chains";
import {injected} from "wagmi/connectors";

import {deploymentMeta} from "./addresses.js";

/// Chain selection. Resolution order:
///   1. NEXT_PUBLIC_CHAIN env override (explicit op-set).
///   2. The deployment manifest's `network` field (synced via `npm run sync:deployment`).
///   3. base-sepolia default (testnet rehearsal target).
const chainName =
  process.env.NEXT_PUBLIC_CHAIN ??
  (deploymentMeta.network === "base" ? "base" : "base-sepolia");
const chain = chainName === "base" ? base : baseSepolia;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL),
  },
  ssr: true,
});

export {chain};
