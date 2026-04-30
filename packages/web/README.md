# @filter-fun/web

Next.js (App Router) + wagmi v2 + viem. Broadcast leaderboard + claim app for filter.fun. Tagline: _Most get filtered. One gets funded. 🔻_

## Pages

- **`/`** — broadcast home: live leaderboard, ticker tape, featured #1 token, finalist quests, filter line, countdown to next cut, activity feed. Uses local simulation data (`useLiveTokens` / `useCountdown` / `useActivityFeed`) for now; swaps to indexer-driven data when the GraphQL surface is wired.
- **`/claim/rollover`** — paste the oracle's per-user settlement entry (`{seasonId, vault, share, proof}`), submit `SeasonVault.claimRollover(share, proof)`.
- **`/claim/bonus`** — paste the oracle's per-user bonus entry (`{seasonId, distributor, amount, proof}`), submit `BonusDistributor.claim(seasonId, amount, proof)`.

The oracle publishes per-user JSON entries cut from the full `buildSettlementPayload` / `buildBonusPayload` output. v0 claim input is paste-from-clipboard; auto-fetched profile views land once the indexer's HTTP API is live.

Stack:

- App Router. Pink / cyan / yellow / purple palette over a deep purple gradient (broadcast/playful direction). Bricolage Grotesque + JetBrains Mono via `next/font`.
- wagmi v2 + viem. Chain choice is env-controlled (`NEXT_PUBLIC_CHAIN`); defaults to Base Sepolia, `base` for mainnet.
- Injected-connector wallet flow.
- React Query for wagmi hooks.
- Workspace-imports `@filter-fun/scheduler` for ABI + call builders, so the contract surface stays in lockstep with the on-chain ABI.
- Responsive — three-column broadcast grid on ≥1100px viewports, single-column below. `prefers-reduced-motion` disables the marquee, pulse, twinkle, and shake animations.

Component layout (broadcast home):

```
src/
├── components/broadcast/   TopBar, TickerTape, Featured, Missions,
│                           Countdown, Leaderboard (+ FilterLine),
│                           ActivityFeed, Stars, Sparkline, StatBar
├── hooks/                  useLiveTokens, useCountdown, useActivityFeed
└── lib/                    tokens (color/font), format, sparkline, seed
```

Out of scope (next PRs):

1. Wire the broadcast UI to live indexer data (replace the three simulation hooks).
2. Finals + season-history views.
3. Auto-fetched claim entries (no paste required).

## Setup

```sh
npm install
cp packages/web/.env.example packages/web/.env.local
# After a deploy: bake addresses into the build.
npm --workspace @filter-fun/web run sync:deployment
npm --workspace @filter-fun/web run dev
```

Open `http://localhost:3000`. With MetaMask (or any injected wallet) installed, click **Connect Wallet** — the header should show the connected address and the resolved chain.

### Deployment manifest

Contract addresses come from `src/lib/deployment.json`, which is overwritten by
`npm run sync:deployment` (it copies
`packages/contracts/deployments/base-sepolia.json` — set `NETWORK=base` for mainnet
or `MANIFEST=/abs/path` to override). The placeholder shipped in this repo has zero
addresses; pre-deploy contract calls will fail at the wallet layer rather than
silently no-op. See [`src/lib/addresses.ts`](./src/lib/addresses.ts) for the typed
export and [`docs/runbook-sepolia-smoke.md`](../../docs/runbook-sepolia-smoke.md) for
the end-to-end flow.

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
