# Robinhood Chain deploy runbook (testnet rehearsal → mainnet genesis)

Target chain for genesis as of 2026-07-09: **Robinhood Chain** (Arbitrum-stack L2, ETH gas,
settles to Ethereum). Base remains in the codebase as the documented emergency-retreat path.

## Network reference (preflight-verified 2026-07-09)

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `4663` | `46630` |
| Public RPC (rate-limited) | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Alchemy RPC (use in prod) | `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}` | `https://robinhood-testnet.g.alchemy.com/v2/{KEY}` |
| Explorer (Blockscout) | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Faucet | — | `https://faucet.testnet.chain.robinhood.com` |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | none canonical — deploy our own (see below) |
| WETH9 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | own deploy (below) |
| CREATE2 deployer (`0x4e59…4956C`) | ✅ present | ✅ present |
| Multicall3 (`0xcA11…CA11`) | ✅ present | ✅ present |
| Block cadence (measured) | ~0.10 s/block under load | ~0.40 s/block |

Chain semantics to keep in mind (Arbitrum family):
- **Contract `block.number` returns the L1 (Ethereum) height** (~25.5M), while RPC
  `eth_blockNumber` returns the L2 height (~5.3M a week after launch). Ponder start
  blocks and the manifest `deployBlockNumber` are L2 heights — sanity-check after the
  first deploy that the manifest value ≈ `cast block-number`.
- Blocks are produced **on demand**: idle chain = no blocks = no Ponder block ticks.
  The rehearsal runs a heartbeat (below); mainnet has organic traffic.
- Cancun opcodes (TSTORE) verified working on both networks (`evm_version = "cancun"` is fine).

## Cut-over-time preflight (re-run before mainnet deploy)

```sh
M=https://rpc.mainnet.chain.robinhood.com
cast chain-id -r $M                                             # 4663
cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C -r $M      # non-empty
cast code 0x8366a39cc670b4001a1121b8f6a443a643e40951 -r $M      # non-empty (PoolManager)
cast call 0x58daec3116aae6d93017baaea7749052e8a04fa7 "WETH9()(address)" -r $M
cast call 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 "symbol()(string)" -r $M   # "WETH"
curl -s https://robinhoodchain.blockscout.com/api/v2/stats >/dev/null && echo blockscout-ok
```
Also record at cutover (not automatable ahead of time):
- Alchemy `eth_getLogs` block-range limits (probe with a wide range against the PoolManager).
- The Uniswap web-app deeplink slug (`app.uniswap.org` → switch to Robinhood Chain → note
  the `?chain=<slug>` URL param; `tradeTokenUrl` in `packages/web/src/lib/chain.ts` assumes
  `robinhood` — fix there if it differs).
- The canonical L1 bridge / Inbox address from docs.robinhood.com/chain (deposits land in
  ~10–15 min; withdrawals have a ~7-day window — treat bridged ETH as one-way for ops).

## Accounts (EOA posture at launch — user decision 2026-07-09)

Roles: deployer, oracle (scheduler signer), mechanics, treasury proposers (may repeat one
EOA), POL-vault owner. Fund on mainnet via the canonical bridge: deployer ~0.2 ETH,
oracle ~0.1 ETH, dust for the rest (Orbit gas is cheap). Rotate owner/oracle to a Safe
once Safe is verified deployed on 4663 — until then, hardware-wallet EOAs.

## Testnet rehearsal (46630)

1. Faucet-fund the deployer.
2. Deploy rehearsal infra (no canonical v4 on testnet): our own `PoolManager` + WETH9 +
   v4 test routers via the infra script (see `packages/contracts/script/`), record addresses
   into `.env.robinhood-testnet`.
3. `./script/deploy-testnet.sh --network robinhood-testnet` — mines HOOK_SALT inline,
   writes `deployments/robinhood-testnet.json`, Blockscout-verifies. **Confirm at least one
   contract verifies** immediately (de-risks the via-ir/runs=1 recompile match).
4. Manifest sanity: `deployBlockNumber` ≈ `cast block-number -r $T`.
5. Point staging indexer + web at 46630 (env matrix below). Start the heartbeat:
   ```sh
   # keeps blocks (and Ponder ticks) flowing on the quiet testnet
   while true; do cast send $ORACLE_ADDR --value 0 --private-key $ORACLE_PK -r $T >/dev/null; sleep 45; done
   ```
6. Compressed season on a `rehearsal/compressed-timers` branch (duration constants are
   `constant` → source patch + `FORCE_REDEPLOY=1`): startSeason → mixed credit + paid
   reservations → activation → swaps → cut → settlement → claims. Plus one aborted season
   → `reclaimCredit` drill.
7. **Unmodified-bytecode smoke deploy from the release tag** (validates the exact mainnet
   bytecode + HOOK_SALT + verification) — launch one token, confirm indexing end-to-end.

Rehearsal pass criteria: hp snapshots at expected wall-clock cadence; finality promotes
tip→soft→final in ~30s/~120s; settlement writer fires; operator console auth works;
explorer links + trade links resolve; wallet add-chain UX clean; CSP clean; `/club` mint →
credit toggle → free launch (`SlotReserved` with `escrowAmount = 0`, `creditFunded: true`)
→ operator card updates.

## Mainnet cutover (4663)

1. Freeze + tag. Re-run the preflight above on `$M`.
2. Bridge ETH to deployer + oracle EOAs (allow deposit latency).
3. `MineHookSalt` against the tag → pin `HOOK_SALT` in `.env.robinhood` (must equal the
   salt from rehearsal step 7 if bytecode is unchanged).
4. `./script/deploy-robinhood.sh` (DeployGenesis + FilterClubPass): env from
   `.env.robinhood.example` — `V4_POOL_MANAGER=0x8366…0951`, `WETH_ADDRESS=0x0Bd7…AD73`,
   oracle/treasury/mechanics EOAs, `FILTER_CLUB_*` (defaults: 250 / 0.05 ether / cap 5 /
   payout = TreasuryTimelock). Writes `deployments/robinhood.json`; Blockscout verify loop.
5. `polVault.acceptOwnership()` from the owner EOA. Commit the manifest.
6. Web sync: `NETWORK=robinhood npm run sync:deployment -w @filter-fun/web`.
7. Railway env flip — indexer first, then web:

| var | indexer testnet | indexer mainnet | web testnet | web mainnet |
|---|---|---|---|---|
| `PONDER_NETWORK` | `robinhoodTestnet` | `robinhood` | — | — |
| `PONDER_RPC_URL_46630` / `_4663` | Alchemy testnet | Alchemy mainnet | — | — |
| `DEPLOYMENT_MANIFEST_PATH` (+`DEPLOYMENT_MANIFEST_REQUIRED=1`) | robinhood-testnet.json | robinhood.json | — | — |
| `HP_SNAPSHOT_INTERVAL_BLOCKS` / `HP_FINALITY_ADVANCER_INTERVAL_BLOCKS` | 750 / 75 | 3000 / 300 (defaults) | — | — |
| `HP_FINALITY_SOFT_SECONDS` / `HP_FINALITY_FINAL_SECONDS` | 30 / 120 (defaults) | 30 / 120 (defaults) | — | — |
| `NEXT_PUBLIC_CHAIN` | — | — | `robinhood-testnet` | `robinhood` |
| `NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL` / `NEXT_PUBLIC_ROBINHOOD_RPC_URL` | — | — | Alchemy | Alchemy |

8. Oracle `startSeason()`; SeedFilter genesis token; **open the Filter Club mint**
   (announce `/club`).
9. Confirm: indexer rows landing, UI, trade deeplink, explorer links, `/club` payload.

Rollback: contracts are abandon-and-redeploy (archive + rm manifest, re-run); indexer/web
roll back via Railway env flip. Base env values remain documented in the `.env.*.example`
files as the retreat path.
