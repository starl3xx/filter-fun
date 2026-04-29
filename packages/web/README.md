# @filter-fun/web

Next.js (App Router) + wagmi v2 + viem. Spectator + claim app for filter.fun.

## v0 scope

This is the bootstrap scaffold:

- App Router shell, dark theme baseline.
- wagmi config wired to Base + Base Sepolia. Chain choice is env-controlled (`NEXT_PUBLIC_CHAIN`).
- Injected-connector "Connect Wallet" button.
- React Query provider for wagmi hooks.

That's it for v0. The next PRs add:

1. Rollover claim flow (consumes oracle's settlement payload, calls `SeasonVault.claimRollover`).
2. Bonus claim flow (consumes oracle's bonus payload, calls `BonusDistributor.claim`).
3. Leaderboard (reads scoring engine's output via the indexer's HTTP API).
4. Finals + season-history views.

## Setup

```sh
npm install
cp packages/web/.env.example packages/web/.env.local
npm --workspace @filter-fun/web run dev
```

Open `http://localhost:3000`. With MetaMask (or any injected wallet) installed, click **Connect Wallet** — the header should show the connected address and the resolved chain.

## Workspace packages used

- `@filter-fun/oracle` — Merkle payload types for claim flows (added in v1).
- `@filter-fun/scheduler` — call builders (`claimRolloverCall`, `claimBonusCall`) for transaction construction.

Both are workspace-linked and transpiled via Next's `transpilePackages`.

## Environment

| Var                                | Default                  | Notes                                                              |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_CHAIN`                | `base-sepolia`           | `base` for mainnet.                                                |
| `NEXT_PUBLIC_BASE_RPC_URL`         | (chain default public)   | Override for production-grade RPC (Alchemy, Infura, your own).     |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` | (chain default public)   | Same, for testnet.                                                 |
