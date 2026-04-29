import {http, createConfig} from "wagmi";
import {base, baseSepolia} from "wagmi/chains";
import {injected} from "wagmi/connectors";

/// Chain selection: default to Base Sepolia for dev/testnet; switch to mainnet by setting
/// `NEXT_PUBLIC_CHAIN=base`. Kept dead-simple here — no chain-switcher UI in v0.
const chainName = process.env.NEXT_PUBLIC_CHAIN ?? "base-sepolia";
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
