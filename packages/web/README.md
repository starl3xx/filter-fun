# @filter-fun/web

Next.js (App Router) + wagmi v2 + viem. Broadcast leaderboard + claim app for filter.fun. Tagline: _Most get filtered. One gets funded. 🔻_

## Pages

- **`/arena`** — main spectator surface (Epic 1.4 + 1.8 web). Live leaderboard with cut line between rank 6 / 7, SSE-powered ticker with five visual states (normal / high-activity / pre-filter / filter-moment / post-filter), top bar with countdown + Champion Pool + Champion Backing Pool, token detail panel with HP component breakdown using spec §6.6 labels, activity feed, and a Trade $TICKER deep-link to the Uniswap interface. Reads `/season`, `/tokens`, `/events` from the indexer (`NEXT_PUBLIC_INDEXER_URL`). Honors `?token=0x…` to pre-select a row (used by `/launch` after a successful launch).
- **`/launch`** — public launch page (Epic 1.5). 12-card slot grid (filled vs `Claim now` vs `Almost gone` vs closed), launch form with name / ticker / description / image URL / optional socials, live cost panel (slot cost + refundable stake), creator-incentives module, and the locked acknowledgment checkbox. Reads `getLaunchSlots` / `getLaunchStatus` / `canLaunch` / `launchesByWallet` directly from `FilterLauncher` (deploy manifest provides the address) and merges with `/tokens` for ticker / HP / status. Submits via `FilterLauncher.launchToken(name, symbol, metadataURI)` with `value = launchCost + refundableStake`. Metadata is pinned via `/api/metadata` before the wallet is touched (see _Metadata pinning_ below).
- **`/`** — broadcast home: live leaderboard, ticker tape, featured #1 token, finalist quests, filter line, countdown to next cut, activity feed. Uses local simulation data (`useLiveTokens` / `useCountdown` / `useActivityFeed`) for now; swaps to indexer-driven data when the GraphQL surface is wired.
- **`/claim/rollover`** — paste the oracle's per-user settlement entry (`{seasonId, vault, share, proof}`), submit `SeasonVault.claimRollover(share, proof)`.
- **`/claim/bonus`** — paste the oracle's per-user bonus entry (`{seasonId, distributor, amount, proof}`), submit `BonusDistributor.claim(seasonId, amount, proof)`.

### API routes

- **`POST /api/metadata`** — accepts `{name, ticker, description, imageUrl, website?, twitter?, farcaster?}`, validates server-side, builds the metadata document, pins it, and returns `{uri, backend}`. The URI is what the client passes to `FilterLauncher.launchToken(...)` as `metadataURI_`.
- **`GET /api/metadata/:slug`** — serves a previously-pinned metadata JSON from the filesystem fallback. Only used when `PINATA_JWT` is unset.

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

Component layout (arena):

```
src/
├── app/arena/page.tsx                  client-rendered, polling + SSE
├── components/arena/                   ArenaTopBar, ArenaTicker, ArenaLeaderboard,
│                                       ArenaTokenDetail, ArenaActivityFeed,
│                                       ArenaFilterMechanic, StatusBadge, HpBar
├── hooks/arena/                        useSeason (3-5s poll), useTokens (5-10s poll),
│                                       useTickerEvents (SSE + dedupe + backoff),
│                                       useTrendBuffers (rolling HP samples)
└── lib/arena/                          api (types + fetch + Uniswap deep-link),
                                        format (Ξ/% helpers), hpLabels (§6.6)
```

Out of scope (next PRs):

1. Wire the broadcast home (`/`) to live indexer data (replace the three simulation hooks).
2. Custom V4 swap UI inside the Arena detail panel — currently links out to the Uniswap interface (slippage / approval / FilterHook routing is its own scope).
3. Filter-moment dramatic overlay (Epic 1.9 — pre-filter countdown screen, dramatic reveal animation, post-filter recap card). The ticker's filter-moment state is in scope today.
4. Profile + graveyard links from rows (Epic 3.1 / 3.2).
5. Finals + season-history views.
6. Auto-fetched claim entries (no paste required).

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

| Var                                | Default                    | Notes                                                              |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_CHAIN`                | `base-sepolia`             | `base` for mainnet.                                                |
| `NEXT_PUBLIC_BASE_RPC_URL`         | (chain default public)     | Override for production-grade RPC (Alchemy, Infura, your own).     |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` | (chain default public)     | Same, for testnet.                                                 |
| `NEXT_PUBLIC_INDEXER_URL`          | `http://localhost:42069`   | Indexer HTTP base — `/season`, `/tokens`, `/events` for the arena. |
| `PINATA_JWT`                       | (unset)                    | **Server-side.** Pinata JWT used by `/api/metadata` to pin token metadata to IPFS. Preferred backend for production. Never expose this to the client. |
| `METADATA_STORE_DIR`               | (unset)                    | **Server-side.** Filesystem fallback when `PINATA_JWT` is not set — `/api/metadata` writes JSON files to this directory and returns a self-hosted URL. Intended for testnet / preview deploys, not production. |
| `METADATA_PUBLIC_URL`              | request origin             | **Server-side.** Public origin used to compose the fallback URL (e.g. `https://filter.fun`). Defaults to the inbound request's host. Only relevant in fallback mode. |

> **At least one of `PINATA_JWT` or `METADATA_STORE_DIR` must be set** in any deploy that exposes `/launch`. With neither configured, `POST /api/metadata` fails with HTTP 500 — preferred to letting a creator submit the form and discover the gap at the wallet step.

## Tests

```sh
npm --workspace @filter-fun/web run test         # one-shot vitest run
npm --workspace @filter-fun/web run test:watch   # watch mode
```

Vitest + jsdom + React Testing Library. Covers: leaderboard rank ordering, cut-line placement, status-badge mapping, SSE hook reconnect + dedupe, ticker state derivation, plus DOM snapshots of the Arena top bar and leaderboard.
