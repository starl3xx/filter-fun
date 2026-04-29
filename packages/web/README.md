# @filter-fun/web

Next.js (App Router) + wagmi v2 + viem. Spectator + claim app for filter.fun.

## Pages

- **`/`** — landing + wallet connect.
- **`/claim/rollover`** — paste the oracle's per-user settlement entry (`{seasonId, vault, share, proof}`), submit `SeasonVault.claimRollover(share, proof)`.
- **`/claim/bonus`** — paste the oracle's per-user bonus entry (`{seasonId, distributor, amount, proof}`), submit `BonusDistributor.claim(seasonId, amount, proof)`.

The oracle publishes per-user JSON entries cut from the full `buildSettlementPayload` / `buildBonusPayload` output. v0 input is paste-from-clipboard; the leaderboard/profile views in subsequent PRs will fetch the entry automatically once the indexer's HTTP API is live.

Stack:

- App Router, dark theme baseline.
- wagmi v2 + viem. Chain choice is env-controlled (`NEXT_PUBLIC_CHAIN`); defaults to Base Sepolia, `base` for mainnet.
- Injected-connector wallet flow.
- React Query for wagmi hooks.
- Workspace-imports `@filter-fun/scheduler` for ABI + call builders, so the contract surface stays in lockstep with the on-chain ABI.

Out of scope (next PRs):

1. Leaderboard (reads scoring engine's output via the indexer's HTTP API).
2. Finals + season-history views.
3. Auto-fetched claim entries (no paste required).

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
