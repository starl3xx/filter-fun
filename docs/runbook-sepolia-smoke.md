# Base Sepolia Smoke-Test Runbook

End-to-end rehearsal of one filter.fun season on Base Sepolia (chain 84532). Covers
deploy → $FILTER seed → public launch → soft filter → finals cut → settlement → rollover
& bonus claim → POL deployment → events stream verification.

If this runbook passes, the contract suite + indexer + web are wired correctly for the
mainnet cutover. Anything that fails here represents a real production bug — don't paper
over it; fix it and re-run from the failed step.

> **Spec refs**: §4 (lifecycle), §5 (genesis token), §27.1 (deploy), §27.7 (smoke-test).

---

## 0. Prereqs

- [ ] Foundry ≥ 1.0 (`foundryup` if needed). The deploy uses cheatcodes that landed in late 2025.
- [ ] `jq` on PATH (the wrapper script reads the manifest with it).
- [ ] Node ≥ 20 + npm. Workspaces are configured at the monorepo root.
- [ ] Funded deployer key on Base Sepolia. ~0.5 ETH recommended (0.05 ETH per launch
      slot * a handful of launches + gas headroom for the deploy itself, which is
      ~12 contracts).
- [ ] Basescan API key. Tier doesn't matter; verification is rate-limit friendly.
- [ ] Canonical Base Sepolia addresses on hand (V4 PoolManager, WETH9). The example env
      file (`.env.sepolia.example`) ships with current values; double-check before each
      deploy in case Uniswap rotates a deployment.

---

## 1. Deploy

```sh
cd packages/contracts
cp .env.sepolia.example .env.sepolia
$EDITOR .env.sepolia                                  # fill DEPLOYER_PRIVATE_KEY,
                                                      # TREASURY_OWNER, SCHEDULER_ORACLE_ADDRESS,
                                                      # BASESCAN_API_KEY
npm run deploy:sepolia                                # idempotent; refuses if a manifest exists
```

**What this does**:

1. Mines the FilterHook CREATE2 salt against the canonical Deterministic Deployer Proxy
   (deterministic — same salt every time given the same hook bytecode).
2. Deploys the suite in dependency order: TreasuryTimelock → BonusDistributor → POLVault
   → FilterLauncher (which inline-deploys CreatorRegistry / CreatorFeeDistributor /
   TournamentRegistry / TournamentVault) → POLManager → FilterHook → FilterFactory.
3. Wires `polManager` ↔ `launcher` ↔ `polVault` (one-shot setters), `factory` ↔ `hook`
   ↔ `launcher`.
4. Applies Sepolia config: `setMaxLaunchesPerWallet(1)`, `setRefundableStakeEnabled(true)`.
5. Transfers POLVault ownership to `POL_VAULT_OWNER` (Ownable2Step — owner accepts in
   step 2 below).
6. Writes `deployments/base-sepolia.json` with every address + the cached hook salt +
   the deploy commit hash + block height.
7. Verifies each contract on Basescan via `forge verify-contract`.

**Verify**:

- [ ] `deployments/base-sepolia.json` exists with non-zero addresses everywhere.
- [ ] Basescan shows green "Contract Source Verified" badges on each address.
- [ ] `cast call $LAUNCHER 'maxLaunchesPerWallet()(uint256)' --rpc-url $BASE_SEPOLIA_RPC_URL`
      returns `1`.
- [ ] `cast call $LAUNCHER 'refundableStakeEnabled()(bool)' --rpc-url ...` returns `true`.

If `forge verify-contract` rate-limits, re-running it is safe (the script uses
`--skip-is-verified-check` to avoid re-uploading already-verified contracts).

## 2. Accept POLVault ownership

POLVault ownership transfer is two-step. The deploy initiated it; the owner must accept.

```sh
cast send $POL_VAULT 'acceptOwnership()' \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $POL_VAULT_OWNER_KEY
```

- [ ] `cast call $POL_VAULT 'owner()(address)' --rpc-url ...` returns `POL_VAULT_OWNER`.

## 3. Open Season 1

```sh
cast send $LAUNCHER 'startSeason()' \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $SCHEDULER_ORACLE_KEY
```

- [ ] `cast call $LAUNCHER 'currentSeasonId()(uint256)' --rpc-url ...` returns `1`.
- [ ] `cast call $LAUNCHER 'phaseOf(uint256)(uint8)' 1 --rpc-url ...` returns `0` (= Launch).

## 4. Seed $FILTER

```sh
# .env.sepolia must have FILTER_METADATA_URI=ipfs://... pointing at:
#   { "name": "filter", "symbol": "FILTER",
#     "description": "Genesis token of filter.fun. Must be able to lose.",
#     "image": "..." }
forge script script/SeedFilter.s.sol:SeedFilter \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast -vvv
```

- [ ] Manifest `filterToken.address` and `filterToken.locker` are now populated.
- [ ] $FILTER token total supply == 1e9 (`cast call $FILTER 'totalSupply()(uint256)' ...`).
- [ ] Spec §5.3 sanity: $FILTER is launched via the protocol-bypass path, but the
      contract treats it identically to a public launch from there on (no special HP /
      settlement / scoring). This is enforced by `FilterLauncher._launch` running the
      same code path with `isProtocolLaunched=true`. **It must be possible for $FILTER
      to lose.**

## 5. Public launches

Open a fresh wallet (not the deployer) and exercise the per-wallet cap:

```sh
# Wallet A: launches a token. Should succeed.
cast send $LAUNCHER 'launchToken(string,string,string)' \
  "Token A" "TOKA" "ipfs://meta-a" \
  --value 0.05ether \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $WALLET_A_KEY

# Wallet A again: must REVERT (LaunchCapReached) — Sepolia cap is 1.
cast send $LAUNCHER 'launchToken(string,string,string)' \
  "Token A2" "TOKA2" "ipfs://meta-a2" \
  --value 0.05ether \
  --rpc-url ... --private-key $WALLET_A_KEY
```

- [ ] First call succeeds, emits `TokenLaunched(seasonId=1, ..., creator=A)`.
- [ ] Second call reverts with `LaunchCapReached`.
- [ ] At least 2 distinct wallets each launched 1 token; we want ≥3 tokens in the season
      so the soft-filter has something to filter.

## 6. Sync indexer + web

```sh
# Indexer
cd packages/indexer
PONDER_NETWORK=baseSepolia PONDER_RPC_URL_84532=$BASE_SEPOLIA_RPC_URL npm run dev

# Web (separate terminal)
cd packages/web
npm run sync:deployment
NEXT_PUBLIC_CHAIN=base-sepolia \
  NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=$BASE_SEPOLIA_RPC_URL \
  npm run dev
```

- [ ] Indexer boots without errors. Boot log shows the launcher/factory addresses.
- [ ] `curl localhost:3000/season` (default Ponder/HTTP port — adjust to your local) returns
      the season object with the launched tokens.
- [ ] `curl localhost:3000/tokens` returns the array of tokens.
- [ ] Open the web app: tokens display, leaderboard renders.

## 7. Soft filter

Advance the launcher to the Filter phase, set the finalists, and trigger a filter event.

```sh
cast send $LAUNCHER 'advancePhase(uint256,uint8)' 1 1 \   # Phase.Filter
  --rpc-url ... --private-key $SCHEDULER_ORACLE_KEY

# Pick which tokens "survive" the filter — the rest forfeit their stake.
cast send $LAUNCHER 'setFinalists(uint256,address[])' 1 "[$TOKEN_A,$TOKEN_B]" \
  --rpc-url ... --private-key $SCHEDULER_ORACLE_KEY
```

- [ ] Indexer events stream emits `FILTER_FIRED` for non-finalist tokens.
- [ ] Non-finalist creators' stakes were forfeited to `forfeitRecipient` (`launchInfoOf`
      shows `refunded=false, filteredEarly=true`).

## 8. Finals + cut

Advance to Finals, then to Settlement. Submit the winner.

```sh
cast send $LAUNCHER 'advancePhase(uint256,uint8)' 1 2 \   # Phase.Finals
  --rpc-url ... --private-key $SCHEDULER_ORACLE_KEY

cast send $LAUNCHER 'advancePhase(uint256,uint8)' 1 3 \   # Phase.Settlement
  --rpc-url ... --private-key $SCHEDULER_ORACLE_KEY

# Submit the winner via the SeasonVault (winner = the token with highest HP at cut).
cast send $SEASON_VAULT 'submitWinner(address,bytes32,bytes32)' \
  $WINNER_TOKEN $ROLLOVER_ROOT $BONUS_ROOT \
  --rpc-url ... --private-key $SCHEDULER_ORACLE_KEY
```

`$ROLLOVER_ROOT` and `$BONUS_ROOT` come from the oracle package. For the smoke test,
generate a minimal merkle tree off-chain (one leaf per loser holder, encoded as
`(holder, share)` per the rollover-share-merkle convention).

- [ ] Winner is recorded in TournamentRegistry as that week's WEEKLY_WINNER.
- [ ] POLManager deploys the season's POL WETH into a permanent V4 LP on the winner
      pool. Verify via `cast call $POL_VAULT 'positionOf(address)(...)' $WINNER_TOKEN`.

## 9. Rollover + bonus claim

A loser holder claims their rollover share + bonus.

```sh
# Generate the merkle proof off-chain for (claimant, share) and (claimant, amount).
cast send $SEASON_VAULT 'claimRollover(uint256,bytes32[],uint256)' \
  1 $PROOF $SHARE \
  --rpc-url ... --private-key $CLAIMANT_KEY

cast send $BONUS_DISTRIBUTOR 'claim(uint256,address,uint256,bytes32[])' \
  1 $CLAIMANT $AMOUNT $PROOF \
  --rpc-url ... --private-key $CLAIMANT_KEY
```

- [ ] Claimant receives winner-token shares (rollover) and WETH (bonus).
- [ ] Indexer emits `RolloverClaimed` and `BonusClaimed` events.
- [ ] `/profile/$CLAIMANT` reflects the new claim aggregates.

## 10. Events stream regression check

With everything else done, hit the SSE endpoint to confirm the priority pipeline works.

```sh
curl -N localhost:3000/events
```

- [ ] Connection holds, heartbeats arrive.
- [ ] HIGH-priority events (FILTER_FIRED, RANK_CHANGED on the winner) stream in
      real-time during steps 7–8.
- [ ] LOW-priority noise (minor HP wobbles) is suppressed when HIGH events queue.

---

## Recovering from a botched deploy

If the deploy half-completes (e.g. ran out of gas mid-way) you'll have a partial
manifest. The script's idempotency guard refuses to redeploy by default:

```
manifest exists; set FORCE_REDEPLOY=1 to overwrite
```

Recovery options:

- **Discard everything**: `rm deployments/base-sepolia.json` and run
  `npm run deploy:sepolia` again. The deployer EOA will produce different addresses
  (different nonce). The previously-deployed contracts remain on-chain but are
  unreachable through the manifest. Cheap on Sepolia.
- **Manual surgery**: edit the manifest by hand to fill in missing addresses, then run
  any further setup (`launcher.setFactory`, etc) via `cast send`. Only worth it on
  mainnet.

## What this runbook deliberately doesn't cover

- **Mainnet deploy** — separate runbook (TBD); requires multisig setup + treasury
  custody design that's out of scope for Sepolia rehearsal.
- **Custom V4 swap UI** — the smoke test uses `cast send` for swaps; the spectator UI
  doesn't ship a swap form in genesis (Phase 2).
- **Arena UI smoke-testing** — Arena page (Epic 1.4 / PR #34) is independent and
  smoke-tested separately once it merges.
- **Indexer scaling** — single-instance Ponder is fine for testnet rehearsal; the
  production indexer scaling story is a separate concern.
