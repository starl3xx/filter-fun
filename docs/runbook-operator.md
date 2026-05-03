# Operator Runbook — filter.fun Season Operations

The standard operating procedures for running a live filter.fun season. Distinct from
`docs/runbook-sepolia-smoke.md`, which is a one-shot rehearsal of the deploy + settlement
flow on testnet — this document is what an on-call operator follows week after week.

> **Spec refs**: §3.2 (locked timeline), §10 (creator incentives), §36.1.5 (cadence),
> §38.6/§38.7 (creator admin model). Cadence numbers come from
> [`packages/cadence`](../packages/cadence) — the single source of truth; do not duplicate
> hour anchors anywhere else.

> **Audience**: on-call operator with shell access, oracle key access, and read access to
> the indexer dashboards.

> **Style**: every "verify" step has a concrete success criterion (a value, an event, a
> log line). If the success criterion isn't met, treat it as an incident — see §6.

---

## 0. Cadence at a glance

Locked 2026-04-30 in spec §3.2. Times are hours from `season.startedAt`:

| Hour | Event | Trigger |
|---:|---|---|
| 0 | Season opens | Operator: `launcher.startSeason()` |
| 48 | Launch window closes | Operator: `launcher.advancePhase(seasonId, Filter)` |
| 96 | **Hard cut** — 12 → 6 | Operator: `setFinalists` + `applySoftFilter` |
| 168 | Settlement — winner crowned | Operator: `seasonVault.submitWinner(...)` |

**Day-of-week mapping** (UTC, Mon-anchored): Mon 00:00 launch → Wed 00:00 launch closes →
Fri 00:00 hard cut → Mon 00:00 settlement (= start of next season).

Confirm cadence env on every container before each season:

```sh
echo "$SEASON_LAUNCH_END_HOUR $SEASON_HARD_CUT_HOUR $SEASON_SETTLEMENT_HOUR"
# Expected: 48 96 168
```

If any value differs from the defaults, **stop** — a misconfigured cadence will mis-time
settlement.

### Drift tolerance & escalation (Audit M-Docs-1)

The hard cut and settlement are wall-clock-anchored to `season.startedAt + N hours`. The
scheduler container's clock and the Base L2 block clock will drift slightly between calls,
so the trigger fires within a small window — not exactly at the second.

- **Tolerance**: the relevant phase-advance / settlement tx should land within **±2
  minutes** of the scheduled hour. Any tx in this window is on-cadence; do not treat it
  as drift.
- **Escalate**: if the trigger has not fired **>5 minutes after** the scheduled hour
  (e.g. hard cut hour 96 — no `applySoftFilter` tx by Fri 00:05 UTC), escalate to
  oncall immediately. Likely causes: scheduler container crashed, RPC degraded, gas
  price spike not absorbed by the bumper, or operator key revoked.
- **Do NOT manually fire while waiting.** The scheduler retries with backoff and a
  manual operator `advancePhase` racing against an in-flight scheduler tx will revert
  one of them and burn gas. Wait until oncall confirms the scheduler is wedged before
  taking the manual path documented in §6.

---

## 1. Pre-week checklist (Sunday → Monday boundary)

Run through this before each new season opens. The window is small: settlement of week N
runs at hour 168 (Mon 00:00), and week N+1 launch starts immediately. Missing any of these
cascades into a live incident.

```sh
# Required env (set before running anything below):
export RPC_URL=$BASE_RPC_URL
export LAUNCHER=$(jq -r .filterLauncher packages/contracts/deployments/base.json)
export TREASURY=$(jq -r .treasuryTimelock packages/contracts/deployments/base.json)
export MECHANICS=$(jq -r .mechanics packages/contracts/deployments/base.json)
export POL_VAULT=$(jq -r .polVault packages/contracts/deployments/base.json)
export BONUS_DIST=$(jq -r .bonusDistributor packages/contracts/deployments/base.json)
```

### 1.1 Verify scheduler container is running latest version

```sh
# Replace with your container orchestration (k8s, Railway, etc.):
kubectl -n filter-fun get pod -l app=scheduler -o jsonpath='{.items[0].spec.containers[0].image}'
# Expect: ghcr.io/.../scheduler:<sha-from-main>
```

- [ ] Image tag matches the latest commit on `main`'s scheduler workflow.
- [ ] If image is stale, redeploy before continuing — running last week's scheduler can
      mis-time the new season's hard cut.

### 1.2 Verify indexer caught up to head

```sh
# Indexer exposes a /status endpoint reporting `headBlock` vs RPC head:
curl -s "$INDEXER_URL/status" | jq '{indexerHead: .headBlock, lag: .blockLag}'
```

- [ ] `blockLag < 3`. If higher, the indexer is behind; restart it (§6.2) before season
      opens. Holders relying on `/profile` and `/tokens` will see stale data otherwise.

### 1.3 Snapshot treasury balances

```sh
cast balance "$TREASURY" --rpc-url "$RPC_URL"
cast balance "$MECHANICS" --rpc-url "$RPC_URL"
cast call "$BONUS_DIST" 'totalUnclaimed()(uint256)' --rpc-url "$RPC_URL"
```

- [ ] Record all three values in the on-call log (channel: `#filter-fun-ops`). End-of-week
      diff must reconcile against expected fee accrual + bonus pool funding.

### 1.4 Snapshot POL Vault state

```sh
# POLVault holds permanent winner-pool LP positions accumulated across seasons.
cast call "$POL_VAULT" 'positionCount()(uint256)' --rpc-url "$RPC_URL"
```

- [ ] Position count equals (number of completed seasons). If lower, last week's POL
      deploy didn't land — this is a P1 incident; do NOT open week N+1 until resolved.

### 1.5 Verify rotated keys (if applicable)

If your operations rotate the scheduler-runner address on a schedule:

```sh
SCHEDULER_RUNNER=$(jq -r .scheduler.address packages/contracts/deployments/base.json)
cast call "$LAUNCHER" 'oracle()(address)' --rpc-url "$RPC_URL"
# Must equal SCHEDULER_RUNNER.
```

- [ ] On-chain `oracle` matches the address held by the live scheduler container.
- [ ] If rotated this week, confirm the new key has gas (≥0.1 ETH on Base mainnet).

### 1.6 Confirm cadence env on the scheduler

```sh
kubectl -n filter-fun exec deploy/scheduler -- env | grep -E '^SEASON_(LAUNCH_END|HARD_CUT|SETTLEMENT)_HOUR'
```

- [ ] All three vars present and equal `48`, `96`, `168` respectively.
- [ ] If any are missing, the scheduler falls back to defaults (which match) — but explicit
      values caught a 2026-Q2 prod incident, so always set them explicitly.

### 1.7 Confirm previous season closed cleanly

```sh
PREV_SEASON=$(($(cast call "$LAUNCHER" 'currentSeasonId()(uint256)' --rpc-url "$RPC_URL") - 1))
PREV_VAULT=$(cast call "$LAUNCHER" "vaultOf(uint256)(address)" $PREV_SEASON --rpc-url "$RPC_URL")
cast call "$PREV_VAULT" 'rolloverRoot()(bytes32)' --rpc-url "$RPC_URL"
cast call "$PREV_VAULT" 'bonusRoot()(bytes32)' --rpc-url "$RPC_URL"
```

- [ ] Both roots non-zero. Zero means last week's settlement aborted before publishing
      Merkle commits — block week N+1 launch and escalate.

---

## 2. During-week monitoring

Run continuously while the season is live. Recommended cadence: every 15 min during launch
window (high traffic), every hour during trading-only, every 5 min in the last hour before
hard cut + settlement.

### 2.1 HP engine health

```sh
curl -s "$INDEXER_URL/tokens" | jq '.[] | {token, hp, hpUpdatedAt: .hpUpdatedAt}' | head -20
```

- [ ] Every token's `hpUpdatedAt` is within the last 5 minutes during the launch + trading
      windows. Stale HP > 10 min on any token = paging incident — see §6.1 (HP frozen).
- [ ] HP values are bounded `[0, 100]`. Out-of-range = scoring bug; rollback indexer
      immediately and freeze the season.

#### Active weight set (Epic 1.17a, 2026-05-03 v4 lock)

```sh
curl -s "$INDEXER_URL/scoring/weights" | jq
```

- [ ] `version` matches the live `HP_WEIGHTS_VERSION` (currently `2026-05-03-v4-locked`).
      A mismatch means the indexer is running stale code — redeploy before next snapshot.
- [ ] `weights` sums to `1.000` and matches spec §6.5: velocity 0.30, effectiveBuyers 0.15,
      stickyLiquidity 0.30, retention 0.15, momentum 0.00, holderConcentration 0.10.
- [ ] `flags.HP_MOMENTUM_ENABLED == false` and `flags.HP_CONCENTRATION_ENABLED == true`
      under the v4 lock. Any deviation must be tied to a published env-override decision
      (the flag flip is itself a weight change for transparency purposes — see
      `docs.filter.fun/protocol/scoring-weights`).
- [ ] `phaseDifferentiation == false` under v4. A future v5 may flip this; if it does,
      the deploy that flipped it should also bump `version`.

Spot-check a recent `hpSnapshot` row to confirm provenance is being stamped:

```sh
psql "$INDEXER_DATABASE_URL" -c "
  SELECT weights_version, flags_active, COUNT(*)
  FROM hp_snapshot
  GROUP BY 1, 2
  ORDER BY 3 DESC LIMIT 5;
"
```

- [ ] All recent rows tagged `weights_version = '2026-05-03-v4-locked'`. Pre-1.17a rows
      backfilled to `'pre-lock'`; if you still see `pre-lock` writes after the deploy,
      treat as an incident (the writer isn't reading the version stamp).
- [ ] `flags_active` = `{"momentum":false,"concentration":true}` for all live writes.

### 2.2 Scheduler heartbeats

```sh
kubectl -n filter-fun logs deploy/scheduler --since=10m | grep -E 'tick|heartbeat'
```

- [ ] Heartbeat log line every minute. Missing heartbeat for >2 min = scheduler stalled.
      Fall back to manual phase advance (§6.1).

### 2.3 Fee router balances

```sh
# CreatorFeeDistributor accumulates per-token; sum across active season:
SEASON=$(cast call "$LAUNCHER" 'currentSeasonId()(uint256)' --rpc-url "$RPC_URL")
TOKENS=$(cast call "$LAUNCHER" "tokensInSeason(uint256)(address[])" $SEASON --rpc-url "$RPC_URL")
# (Loop is environment-specific; see scripts/check-fees.sh in your ops repo.)
```

Sanity check: total creator-fee accrual ≈ `(volume) × 200bps × (0.20 / 2.00)`. If accrual
is materially below the expected slice, the FilterLpLocker may not be forwarding swaps
correctly — see §6.3 (Hot-fix deploy).

### 2.4 Indexer queue depth

```sh
curl -s "$INDEXER_URL/status" | jq '.queueDepth'
```

- [ ] Queue depth drains within seconds of swap volume bursts. Sustained queue >200 events
      = indexer falling behind; restart and verify backfill (§6.2).

### 2.5 SSE connection count

```sh
curl -s "$INDEXER_URL/status" | jq '.sseConnections'
```

- [ ] Anomalously high count (e.g., 10x baseline) is a scraping signal. Not a hard fail
      but worth flagging in ops log so post-mortem can correlate.

---

## 3. Filter event SOP (Friday 00:00 UTC — hour 96)

The first hard cut (12 → 6). High-stakes — this is the moment most user attention is on
the protocol. Every action needs a witness.

### 3.1 T-15 minutes

- [ ] On-call operator is the watcher. Confirm on `#filter-fun-ops` ("I have the cut").
- [ ] Pull current ranking:
      ```sh
      curl -s "$INDEXER_URL/season/$SEASON" | jq '.tokens | sort_by(-.hp) | .[] | {symbol, hp, rank}'
      ```
- [ ] Verify scheduler is queued for `advancePhase` and `setFinalists`:
      ```sh
      kubectl -n filter-fun logs deploy/scheduler --since=15m | grep -E 'queued|next-fire'
      ```

### 3.2 T-0

The scheduler fires on its own clock. Do not pre-emptively fire — that races the
scheduler and produces double-advancement reverts. Watch only.

```sh
# Phase advance from Trading (1) → Filter (2):
cast call "$LAUNCHER" 'phaseOf(uint256)(uint8)' $SEASON --rpc-url "$RPC_URL"
# Expect: 2 (Filter) at T+0, then 3 (Finals) once setFinalists settles.
```

### 3.3 T+5 minutes — verify the cut landed

```sh
# Top-6 finalists are flagged in the launcher:
SEASON_VAULT=$(cast call "$LAUNCHER" "vaultOf(uint256)(address)" $SEASON --rpc-url "$RPC_URL")
# Each token's TokenEntry.isFinalist should be true for top-6, false for bottom-6.
for T in $TOKENS; do
  cast call "$LAUNCHER" "entryOf(uint256,address)(uint8,address)" $SEASON $T --rpc-url "$RPC_URL"
done
```

- [ ] 6 tokens flagged finalist; 6 not.
- [ ] Filtered (non-finalist) tokens emit `StakeForfeited` if they used refundable stakes
      and didn't survive — confirm via Basescan event log on the launcher.

### 3.4 T+10 minutes — settlement-engine pickup

- [ ] Indexer's `/events` SSE emits a `FILTER_FIRED` per non-finalist with HIGH priority.
- [ ] CreatorFeeDistributor emits `CreatorFeeDisabled(token)` for each filtered token —
      the 0.20% fee redirects to treasury for those tokens from this point on.
- [ ] Update `#filter-fun-ops`: "Cut landed clean. 6 finalists: $LIST."

### 3.5 If the scheduler stalls

See §6.1 — operators have the oracle key and can manually advance phases. Be careful:
manual fire happens AT the hour anchor, not before. A pre-emptive fire creates a
discrepancy between spec timing and on-chain state that's a pain to reconcile post-hoc.

---

## 4. Settlement SOP (Sunday 24:00 / Monday 00:00 — hour 168)

The full week-end. Heavier procedure than the hard cut: POL deploy, Merkle root publish,
bonus registration, and the season-N+1 boundary all happen in a tight window.

### 4.1 Order of operations

The scheduler fires these in sequence. Confirm each before moving on. Do NOT batch — if
one step fails, the recovery procedure depends on which step.

1. **Phase advance** to Settlement: `launcher.advancePhase(seasonId, Settlement)`.
2. **Submit winner**: `seasonVault.submitWinner(winnerToken, rolloverRoot, bonusRoot)`.
3. **POL deploy** (in-call from `submitWinner`): season's accumulated WETH funds a
   permanent V4 LP position on the winner pool, locked in `POLVault`.
4. **Losers pot split**: 45/25/10/10/10 to filtered creators + 2.5% champion bounty,
   distributed by `seasonVault` via `applyLoserSplits`.
5. **Bonus registration**: BonusDistributor receives the bonus pool and starts the 14-day
   claim clock (`bonusUnlockDelay`).

### 4.2 Verifications

After the scheduler reports completion (typically ~3 min after T+0):

```sh
# 1. Winner is recorded.
WINNER=$(cast call "$SEASON_VAULT" 'winner()(address)' --rpc-url "$RPC_URL")
echo "Week winner: $WINNER"

# 2. Merkle roots match the oracle's pre-published commits.
ROLLOVER=$(cast call "$SEASON_VAULT" 'rolloverRoot()(bytes32)' --rpc-url "$RPC_URL")
BONUS=$(cast call "$SEASON_VAULT" 'bonusRoot()(bytes32)' --rpc-url "$RPC_URL")
# Compare to oracle's pre-published file:
diff <(cat oracle/season-$SEASON-roots.json | jq -r .rolloverRoot) <(echo "$ROLLOVER")
diff <(cat oracle/season-$SEASON-roots.json | jq -r .bonusRoot) <(echo "$BONUS")
```

- [ ] Both diffs return empty. **A mismatch means the oracle's published roots don't
      match what landed on-chain — this is custodial-safety class P0**: holders can't
      claim, and your pre-publish commit is now invalid. Escalate immediately.

```sh
# 3. POL deploy confirmed.
cast call "$POL_VAULT" "positionOf(address)(uint128,uint160,int24,int24)" $WINNER --rpc-url "$RPC_URL"
# Expect non-zero liquidity, valid tick range.
```

```sh
# 4. BonusDistributor balance grew by the expected pool.
EXPECTED_BONUS=$(jq -r .bonusPoolWei oracle/season-$SEASON-roots.json)
cast call "$BONUS_DIST" 'totalDeposited()(uint256)' --rpc-url "$RPC_URL"
# Check the delta from the pre-week snapshot equals EXPECTED_BONUS.
```

- [ ] Delta matches the oracle's expected pool size (within rounding). Mismatch = the
      losers-pot split routed to the wrong recipient; escalate.

### 4.3 Communications cadence

- T+0: "Settlement starting. Watching." (post in `#announcements`)
- T+5: "Winner: $SYMBOL ($WINNER)." (with replay link if the web replay UI is live)
- T+15: confirmation that POL deployed and rollover/bonus claim is open.
- T+15: open week N+1 launch (which the scheduler does automatically at T+0 — confirm).

### 4.4 If something stalls

- **POL deploy reverts**: `submitWinner` rolls back, leaving Phase=Settlement and no
  winner recorded. Diagnose the revert reason (Basescan), fix root cause, retry. Do NOT
  manually swap to Finals to "retry" — phase is monotonic.
- **Merkle root mismatch**: STOP. Don't open week N+1 until reconciled. The pre-publish
  commit + on-chain root divergence may indicate oracle key compromise.

---

## 5. Creator admin updates (Epic 1.12)

Token creators interact with three on-chain primitives on `CreatorRegistry`. This section
is the operator-facing reference; the creator-facing flow is in
[`docs/creator-admin.md`](./creator-admin.md) (Epic 1.11 deliverable).

### 5.1 The auth model

- **Creator** (immutable): set at launch, never changes. Identity attribution.
- **Admin** (mutable, defaults to creator): can mutate metadata / recipient / admin.
- **Recipient** (mutable, defaults to creator): where the 0.20% creator fee flows.

Operators do not call these directly in normal ops. They surface in support tickets when:
- A creator lost their wallet → they ask the operator to "reset admin." **You can't.**
  Two-step transfer is mandatory; if the creator can't sign, the only path is for the
  current admin to nominate a new wallet they DO control.
- A creator wants fees redirected to a Safe / smart wallet → they call
  `setCreatorRecipient` themselves; no operator action.
- A creator updates metadata → they call `setMetadataURI` themselves.

### 5.2 Update metadata URI

The creator/admin hosts new metadata (IPFS pin recommended) and calls:

```sh
# Creator runs this — operator only does it as a guided support session.
cast send $CREATOR_REGISTRY "setMetadataURI(address,string)" \
  $TOKEN "ipfs://<new-cid>" \
  --rpc-url "$RPC_URL" --private-key $ADMIN_KEY
```

- [ ] Reverts with `EmptyURI` if URI is empty (intentional — no clearing via empty string).
- [ ] Reverts with `NotAdmin` if caller isn't the current admin.
- [ ] On success, emits `MetadataURIUpdated(token, admin, uri)`.

Indexer cache TTL is ~30s for token-level data. After that window, `/tokens` reflects the
new URI. The web app should re-fetch metadata on the next render.

### 5.3 Update creator-fee recipient

```sh
cast send $CREATOR_REGISTRY "setCreatorRecipient(address,address)" \
  $TOKEN $NEW_RECIPIENT \
  --rpc-url "$RPC_URL" --private-key $ADMIN_KEY
```

- [ ] Reverts with `ZeroRecipient` if `$NEW_RECIPIENT == 0x0` (footgun guard).
- [ ] Reverts with `NotAdmin` if caller isn't the current admin.
- [ ] On success, emits `CreatorRecipientUpdated(token, oldRecipient, newRecipient)`.

The next time anyone calls `creatorFeeDistributor.claim(token)`, WETH is paid to
`$NEW_RECIPIENT`. The creator (caller of `claim`) is unchanged — only the destination of
the funds moves.

### 5.4 Two-step admin transfer

The footgun this prevents: a single-step transfer lets an admin lock themselves out by
typing the wrong address. The two-step flow forces the new admin to demonstrate control of
their wallet before the transfer completes.

**Step 1 — current admin nominates:**

```sh
cast send $CREATOR_REGISTRY "nominateAdmin(address,address)" \
  $TOKEN $NEW_ADMIN \
  --rpc-url "$RPC_URL" --private-key $CURRENT_ADMIN_KEY
```

- [ ] Until step 2 lands, the **current** admin still has full control. Nothing has
      transferred yet — the nomination is just a pending state.
- [ ] On success, emits `AdminNominated(token, currentAdmin, pendingAdmin)`.

**Step 2 — new admin accepts (from the new wallet):**

```sh
cast send $CREATOR_REGISTRY "acceptAdmin(address)" \
  $TOKEN \
  --rpc-url "$RPC_URL" --private-key $NEW_ADMIN_KEY
```

- [ ] Reverts with `NotPendingAdmin` if caller isn't the address that was nominated.
- [ ] On success, emits `AdminUpdated(token, oldAdmin, newAdmin)` and clears the pending
      slot.

**Cancel a pending nomination:**

```sh
cast send $CREATOR_REGISTRY "cancelNomination(address)" \
  $TOKEN \
  --rpc-url "$RPC_URL" --private-key $CURRENT_ADMIN_KEY
```

Reverts with `NoPendingAdmin` if there's nothing to cancel. Use when the admin nominated
the wrong address and wants to clear the pending slot before nominating again.

### 5.5 Indexer cache implications

`CreatorRegistry` events flow through the indexer. The token's API surface (admin /
recipient / metadata URI) reflects updates within one cache TTL — typically ~30 seconds.

If a creator reports "I changed recipient but the UI still shows the old address":
1. Wait one cache TTL.
2. `curl "$INDEXER_URL/tokens" | jq '.[] | select(.address == "'$TOKEN'") | .recipient'` —
   if this returns the new value but the web UI does not, the issue is web-side caching.
3. If the indexer also returns the old value > 1 min after the tx confirmed, the indexer
   missed the event — restart and backfill (§6.2).

### 5.6 Creator bag-lock (Epic 1.13 — Sepolia-only until Epic 2.3 audit)

Bag-lock is the killer trust differentiator (spec §38.5/§38.8). Creators opt in to
time-locking their own holdings via the `CreatorCommitments` contract. Locks can extend,
**never shorten**. There is no admin override and no escape hatch — by design.

> **Mainnet status: NOT ACTIVE.** The CreatorCommitments contract is deployed on Base
> Sepolia for the genesis cohort. Mainnet activation is gated on the Epic 2.3 audit. Do not
> direct mainnet creators to call `commit` until that audit signs off and a new mainnet
> FilterFactory has been redeployed.

> **Pre-1.13 token caveat (Sepolia).** FilterTokens deployed BEFORE this version (the
> initial Sepolia $FILTER + first cohort) do not consult the CreatorCommitments contract
> at transfer time — the gating code isn't in their bytecode. Bag-lock applies only to
> tokens launched AFTER the post-1.13 FilterFactory redeploy. Creators of pre-1.13 tokens
> who try to commit will see the call revert with `TokenNotRegistered` only if the token
> was never registered; if registered, `commit` will succeed but **the lock won't enforce**
> because the token's bytecode doesn't gate transfers. Communicate this loudly when
> answering Sepolia support.

**The contract**:

```sh
COMMITMENTS=$(jq -r .creatorCommitments packages/contracts/deployments/base-sepolia.json)
```

**Creator commits to a lock** (creator-of-record only — admin transfers do NOT carry this
right; this is a personal commitment by the original launcher):

```sh
# UNIX timestamp of unlock. Creator runs this themselves; operator only does as guided
# support. Lock can be extended later but never shortened.
LOCK_UNTIL=$(date -d '30 days' +%s)
cast send "$COMMITMENTS" "commit(address,uint256)" \
  $TOKEN $LOCK_UNTIL \
  --rpc-url "$RPC_URL" --private-key $CREATOR_KEY
```

- [ ] Reverts with `TokenNotRegistered` if the token was never registered with the launcher.
- [ ] Reverts with `NotCreator` if the caller isn't the creator-of-record (admin transfers
      do NOT grant this right).
- [ ] Reverts with `LockMustBeFuture` if `lockUntil <= block.timestamp`.
- [ ] Reverts with `LockCannotShorten` if `lockUntil <= existing unlock`.
- [ ] On success, emits `Committed(creator, token, lockUntil, previousUnlock)`.

**Read a creator's lock state** (no auth required — public surface):

```sh
cast call "$COMMITMENTS" "isLocked(address,address)(bool)" $CREATOR $TOKEN --rpc-url "$RPC_URL"
cast call "$COMMITMENTS" "unlockOf(address,address)(uint256)" $CREATOR $TOKEN --rpc-url "$RPC_URL"
```

**What the lock actually does**:

- The creator's own balance of `$TOKEN` cannot leave their wallet (any transfer from the
  locked address — direct, via `transferFrom`, via swap routing — reverts with
  `TransferLocked`).
- Incoming transfers TO the locked address still work — creators can keep accruing fees /
  tips while locked.
- Mints (token construction) bypass the gate; relevant only at deploy time.

**What the lock does NOT do** (these are the false-trust risks the UI must surface
loudly — see `docs/bag-lock.md`):

- It does NOT cover tokens the creator transferred to other wallets BEFORE committing.
  Those balances move freely.
- It does NOT prevent the creator from buying more tokens. Incoming credits the locked
  address; only outgoing is gated.
- It cannot be reversed. If the creator loses their wallet key, the bag is permanently
  locked. (This is the structural guarantee — that's what makes the lock credible.)

**There is no operator action for unlocking.** None. If a creator asks the operator to
"shorten my lock" or "let me out early":

1. Confirm the request is genuine (not a phishing attempt against ops).
2. Politely decline. Point them at `docs/bag-lock.md`.
3. Do not propose deploying a new commitments contract as a workaround — even if a new
   contract were deployed, the existing FilterToken would still consult the old one (the
   commitments address is immutable in the token's bytecode).

**Operator-level ops actions on the commitments contract**: none. The contract has no
owner, no pause, no admin. If a security issue is found post-deploy, the remediation is to
deploy a new commitments contract + new factory + accept that legacy tokens still gate
against the old one. Coordinate any such change through the audit firm before broadcasting.

---

## 6. Incident response

### 6.1 Scheduler down (or stuck)

The scheduler is just a process that fires `advancePhase` / `setFinalists` /
`submitWinner` at specific hours. If it's down, the operator fires manually with the
oracle key. Phase machine is monotonic — pre-firing is destructive (you can't go back).

```sh
# Confirm current phase first.
cast call "$LAUNCHER" 'phaseOf(uint256)(uint8)' $SEASON --rpc-url "$RPC_URL"
# 0=Launch, 1=Filter, 2=Finals, 3=Settlement.

# Manually advance (only at the hour anchor — see §0):
cast send "$LAUNCHER" 'advancePhase(uint256,uint8)' $SEASON $TARGET_PHASE \
  --rpc-url "$RPC_URL" --private-key $ORACLE_KEY
```

- [ ] Pre-firing is destructive. If you're not AT the hour anchor, do not fire.
- [ ] Restart the scheduler container before the next anchor:
      ```sh
      kubectl -n filter-fun rollout restart deploy/scheduler
      ```
- [ ] Confirm a heartbeat appears in logs within 60s.

### 6.2 Indexer behind

```sh
# Restart indexer:
kubectl -n filter-fun rollout restart deploy/indexer
# Tail logs and watch for backfill completion:
kubectl -n filter-fun logs -f deploy/indexer | grep -E 'backfill|caught-up'
```

- [ ] Backfill should complete within minutes for normal lag (Ponder is fast).
- [ ] Verify head matches RPC head after restart:
      ```sh
      INDEXER_HEAD=$(curl -s "$INDEXER_URL/status" | jq -r .headBlock)
      RPC_HEAD=$(cast block-number --rpc-url "$RPC_URL")
      echo "$INDEXER_HEAD vs $RPC_HEAD (delta $((RPC_HEAD - INDEXER_HEAD)))"
      ```
- [ ] Delta < 3 blocks. If higher after 5 min, escalate — possible RPC issue or DB
      corruption.

### 6.3 Hot-fix deploy

Re-deploying a single contract mid-season is destructive: the launcher / vaults / fee
distributors are wired to specific addresses. Replacing one breaks the entire wiring chain.

**Strong preference: wait until between-seasons.** Hour 168 → hour 0 of the next season
is a clean cut — POL is deployed, Merkle roots are published, no mid-flight state to
preserve.

If you must hot-fix mid-season:

1. Pause the launcher: `cast send "$LAUNCHER" 'pause()' --rpc-url ... --private-key $OWNER_KEY`.
2. Deploy the patched contract.
3. Update wiring (this varies by contract — see specific deploy script).
4. Update indexer config + restart.
5. Update web `deployments/base.json` + redeploy.
6. Unpause the launcher.

Communicate proactively: post in `#announcements` BEFORE the pause, with ETA for unpause.

### 6.4 Pause / kill switch

The launcher has `pause()` / `unpause()` on the owner. Pausable functions: `startSeason`,
`launchToken`, `launchProtocolToken`, `advancePhase`. **NOT** pausable:
`applySoftFilter`, `submitWinner`, claims.

When to pause:
- A discovered bug in launch-window pricing or refundable-stake logic, BEFORE settlement.
- Active exploit in progress (gas grief, unexpected revert in `_launch`).

When NOT to pause:
- Mid-finals, mid-cut, mid-settlement. Pausing here doesn't stop the harm — claims,
  filter, settlement aren't pausable — but it does prevent recovery from running.
- "Just to be safe" while investigating something cosmetic. Pausing is loud and damages
  trust; reserve for genuine emergencies.

### 6.5 Communications

Templates in `docs/incident-templates/`. The rules:
- **Acknowledge fast** (under 5 min): "We're aware of $X and investigating. Update in 15."
- **Never speculate about root cause** until post-mortem. "We're investigating" beats
  guessing wrong.
- **Don't promise a fix-by time** unless you know it. Promise the next update time
  instead.
- **Post-mortem within 48h** of resolution. Use the template in §7.

---

## 7. Post-mortem template

Copy this for every incident that triggered §6, regardless of severity. The exercise
matters more than the artifact — running through it surfaces process gaps.

```markdown
# Post-mortem: <one-line summary>

**Date**: YYYY-MM-DD
**Severity**: P0 / P1 / P2
**Duration**: HH:MM (T+0 from first detection to mitigation)
**On-call**: <handle>

## Summary

<2–3 sentences. What happened, what was the impact, how was it resolved.>

## Timeline (UTC)

- HH:MM — first signal (alert / report / log line that started this)
- HH:MM — acknowledged by on-call
- HH:MM — root cause identified
- HH:MM — mitigation applied
- HH:MM — verified resolved
- HH:MM — post-mortem started

## Impact

- Users affected: <count or "unknown">
- Funds affected: <amount or "none">
- Public visibility: <yes/no — was this seen externally?>

## Root cause

<What actually caused this. Be specific. Link to code if applicable.>

## Why didn't we catch this earlier?

<Honest answer. "We didn't have monitoring for X." "We assumed Y was always true."
"This was discussed in PR #N but the concern wasn't acted on.">

## What went well

<Don't skip this section. Reinforce process steps that worked.>

## What went poorly

<Don't skip this section either. Be specific.>

## Action items

| Action | Owner | Due |
|---|---|---|
| <Concrete change to prevent recurrence> | <handle> | YYYY-MM-DD |

## References

- Alert: <link>
- Tx: <basescan link>
- PR fix: <link>
- Discord thread: <link>
```

---

## 8. Full season smoke test (Sepolia, end-to-end)

Run before every mainnet deploy. Validates the entire week-long lifecycle on Base Sepolia
in a fast-forwarded form: deploy → seed → start season → fake launches → cut → settle →
verify. Catches wiring regressions, manifest schema drift, and anything that depends on
real V4 PoolManager behavior (which mock tests miss).

The smoke test is destructive — it leaves the Sepolia deploy in `Settled` phase and
exhausts the launcher's max-launches-per-wallet budget. Spin up a fresh deploy first, or
plan to redeploy via §8.6 after.

### 8.0 Prerequisites

- A Base Sepolia RPC URL with sufficient rate limit (Alchemy/Infura free tier works).
  Set `BASE_SEPOLIA_RPC_URL`.
- A funded deployer wallet (testnet ETH from a faucet — ~0.5 ETH is plenty).
  Set `DEPLOYER_PRIVATE_KEY`.
- A Basescan API key for verification (optional but recommended).
  Set `BASESCAN_API_KEY`.
- The other `.env.sepolia.example` knobs filled in (`TREASURY_OWNER`,
  `SCHEDULER_ORACLE_ADDRESS`, etc.). The defaults in the example file are safe placeholders
  only — operator-controlled wallets should replace them.

### 8.1 Deploy

```sh
cd packages/contracts
./script/deploy-sepolia.sh
```

Manifest lands at `./deployments/base-sepolia.json`. Confirm:

- `addresses.filterLauncher` is non-zero.
- `addresses.creatorCommitments` is non-zero (regression check for PR #43).
- `config.maxLaunchesPerWallet == 1` (spec §4.6 lock).

### 8.2 Verify wiring (pre-seed)

```sh
SKIP_FILTER_TOKEN_CHECK=1 forge script script/VerifySepolia.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expect a `VerifySepoliaOK` event in the trace with `filterTokenChecked=false` and
`tokensChecked=0`. Any `AssertionFailed_<n>` revert means the deploy is misconfigured —
do NOT proceed; fix the wiring first.

### 8.3 Open season + seed $FILTER

```sh
# Oracle starts season 1 (must be the wallet matching SCHEDULER_ORACLE_ADDRESS).
cast send "$FILTER_LAUNCHER" 'startSeason()' \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$ORACLE_PRIVATE_KEY"

# Deployer seeds $FILTER (writes filterToken into the manifest).
forge script script/SeedFilter.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

Confirm: `manifest.filterToken.address` is now non-zero.

### 8.4 Verify wiring (post-seed)

```sh
forge script script/VerifySepolia.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expect `VerifySepoliaOK` with `filterTokenChecked=true`, `tokensChecked=1`. The on-chain
`creatorOf($FILTER)` should be the deployer EOA.

### 8.5 Public launch + lifecycle (optional, manual)

The remaining steps (launchToken, advancePhase to Filter, applySoftFilter, advancePhase
to Settle, submitWinner, claim flows) are manual on testnet. The §1–§4 SOPs cover each.
For a fast smoke test focused on contract wiring, §8.4 is the bar; for a full lifecycle
rehearsal, walk through §1.4 → §3 → §4 against the testnet deploy with the season hours
mocked via `cast rpc anvil_setNextBlockTimestamp` (Sepolia doesn't support this — use a
local fork-mode anvil for time travel).

### 8.6 Factory rotation (post-PR-#43 fix)

If the live Sepolia deploy predates PR #43 (CreatorCommitments wiring), the factory
constructor doesn't accept a CreatorCommitments arg and newly-launched tokens won't
record their bag-locks. Rotate via:

```sh
# Pre-flight check — refuses if the current season has any public launches:
forge script script/RedeployFactory.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"

# If active launches exist and you accept they'll be orphaned:
ACTIVE_LAUNCH_OK=1 forge script script/RedeployFactory.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

The script archives the prior manifest under `./deployments/archive/` with a unix-ts
suffix, mines a fresh `HOOK_SALT` strictly above the cached one (so the new FilterHook
lands at an unoccupied CREATE2 address), and writes the new addresses into
`./deployments/base-sepolia.json`. Trace contains a `FactoryRedeployed` event.

After rotation:

1. Update `INDEXER_RPC_URL` and `INDEXER_FILTER_LAUNCHER` (and the equivalent web/
   scheduler envs) to the new launcher address.
2. Re-run §8.3 (open season + seed $FILTER) on the new system — the prior $FILTER token
   is on the OLD launcher and is orphaned.
3. Re-run §8.4 to confirm wiring.
4. If any creators on the OLD CreatorRegistry need their admin rotated to a different
   wallet on the NEW CreatorRegistry, run nominateAdmin/acceptAdmin against the new
   registry. The old registry remains on chain but is no longer referenced by the
   launcher.

### 8.7 Pre-mainnet checklist

Before promoting `deployments/base-sepolia.json` patterns to `deployments/base.json`:

- [ ] §8.4 verifier passes against Sepolia
- [ ] Indexer reads new manifest cleanly (`/season/1` returns the seeded $FILTER)
- [ ] Web app loads with new addresses (no console errors, leaderboard renders)
- [ ] `MAX_LAUNCHES_PER_WALLET=1` is set in mainnet env (spec §4.6 lock)
- [ ] `BASE_RPC_URL` points to a paid-tier endpoint (rate limits matter for indexer)
- [ ] Treasury owner + oracle wallets are operator-controlled (not deployer EOA)
- [ ] One operator has dry-run §3 (Filter SOP) and §4 (Settlement SOP) on Sepolia

---

## Appendix A — Known gotchas (lessons from prior incidents)

These are real failure modes caught in code review, post-mortems, or testing. Memorize.

### A.1 `set -x` leaks secrets in CI logs

PR #36 had two instances. Bash's `set -x` expands all variables on the trace line, which
means any `cast wallet ... --private-key "$KEY"` or `forge verify-contract ...
"$BASESCAN_API_KEY"` invocation under tracing dumps the secret to stderr.

**Rule**: `set -x` is BANNED in any script that touches `--private-key` or API keys. If
you need command echoing for debugging, echo the command without expansion: `set +x; echo
"running: cast send <redacted-key>"; set -x` won't help either — even `echo "$VAR"` leaks
under `-x`. Just don't enable tracing in those scripts.

### A.2 Silent boolean fallbacks in env parsers

`_envBool` in `DeploySepolia.s.sol` whitelisted `"true" / "TRUE" / "1"` and friends. A
deployer who set `FORCE_REDEPLOY=True` (capital T) silently got `false` back — the
idempotency guard NOT bypassed despite their explicit intent.

**Rule**: env parsers that fall back to a default on unrecognized input are a footgun.
Either accept everything case-insensitively (and document it) or REJECT unknown values
loudly. The current pattern is to reject — match it. Same applies to numeric parsers:
`SEASON_HARD_CUT_HOUR="ninety-six"` should throw, not fall back.

### A.3 `tearDown` is not a Foundry hook

PR #36's Deploy.t.sol had a `tearDown()` that the runner never invoked. The correct hook
is `afterTest()`. The test passed because `freshEnv` cleaned up at the start of the next
test, masking the missing teardown.

**Rule**: pre-test cleanup masks missing post-test cleanup. If you write `afterTest`,
verify it actually runs (add a side effect that would fail if skipped).

### A.4 `vm.parseJsonString` on a JSON object

Same PR. Double-seed guard checked if `.filterToken` was already populated using
`vm.parseJsonString`. After the first seed populated `.filterToken` as a JSON object
(not a string), the second invocation's parse throws — and the surrounding
try/catch interpreted that as "no key, fresh state," allowing re-seeding.

**Rule**: `parseJsonString` failing means "value is not a string" not "key absent." Use
`vm.keyExistsJson` first (or accept both shapes explicitly). More broadly: don't use
exception flow for control flow when the exception conflates "missing" with "wrong shape."

### A.5 Pre-firing the phase machine

Phase transitions are monotonic. Once advanced, you can't go back. Manual fires should
ONLY happen AT the hour anchor — never before, never to "get ahead of the scheduler."

**Rule**: if §6.1 says fire at hour 96, and your watch reads 95:58, **wait two minutes**.

### A.6 Pausing mid-cut or mid-settlement

`applySoftFilter`, `submitWinner`, and claim functions are deliberately NOT pausable —
pausing them would lock funds. But pausing the launcher mid-cut leaves the system in a
half-state: a phase advance won't fire, but claims / soft-filter still resolve.

**Rule**: pause is a launch-window / pre-cut tool. By the time the scheduler is firing
`advancePhase`, pausing is closer to a self-DoS than a safety mechanism. See §6.4.

---

## Appendix B — Useful one-liners

```sh
# Show the current season's phase + remaining time to next anchor:
SEASON=$(cast call "$LAUNCHER" 'currentSeasonId()(uint256)' --rpc-url "$RPC_URL")
PHASE=$(cast call "$LAUNCHER" 'phaseOf(uint256)(uint8)' $SEASON --rpc-url "$RPC_URL")
START=$(cast call "$LAUNCHER" 'launchStartTime(uint256)(uint256)' $SEASON --rpc-url "$RPC_URL")
NOW=$(date +%s)
ELAPSED=$(( (NOW - START) / 3600 ))
echo "Season $SEASON: phase=$PHASE, hour $ELAPSED of 168"

# List all tokens in current season with HP:
curl -s "$INDEXER_URL/season/$SEASON" | jq '.tokens | sort_by(-.hp) | .[] | "\(.symbol)\t\(.hp)"'

# Force-refresh one token's indexer state (cache bust):
curl -s "$INDEXER_URL/tokens?bypass=1" >/dev/null

# Confirm scheduler heartbeat in last 5 min:
kubectl -n filter-fun logs deploy/scheduler --since=5m | grep -c 'heartbeat'
# Expect: ≥1
```

---

## Appendix C — When in doubt

Three hard rules:

1. **Don't pre-fire phase transitions.** Wait for the hour anchor.
2. **Don't speculate publicly about cause.** "Investigating" beats wrong guesses.
3. **Don't pause without ETA.** A pause without an unpause time creates more panic than
   the original bug.

If you're unsure, post in `#filter-fun-ops` and wait for a second pair of eyes. The
season won't be saved by acting fast — it will be ruined by acting wrong.
