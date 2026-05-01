# @filter-fun/scheduler

Drives the on-chain lifecycle of a season. Two arcs:

**Phase arc** (oracle-only on `FilterLauncher`):
1. `startSeason()` — opens a fresh season
2. `advancePhase(seasonId, target)` — Launch → Filter → Finals → Settlement → Closed
3. `setFinalists(seasonId, finalists)` — locks in who advanced past the filter cut

**Settlement arc** (oracle + permissionless keepers on `SeasonVault`):
1. `submitSettlement(winner, losers, minOuts, root, totalShares, deadline)` — oracle-only
2. `liquidate(loser, minOutOverride)` — once per loser, permissionless
3. `finalize(minRolloverOut, minPolOut)` — allocates the pot, AMM-buys winner tokens

**Bonus arc** (oracle + per-holder claim on `BonusDistributor`):
1. `postRoot(seasonId, root)` — oracle-only, after the 14-day hold window
2. `claim(seasonId, amount, proof)` — permissionless, called by each eligible holder

## API

### Settlement arc

```ts
import {runSettlement} from "@filter-fun/scheduler";
import {buildSettlementPayload} from "@filter-fun/oracle";

const payload = buildSettlementPayload({...});

const result = await runSettlement(driver, vaultAddress, payload, {
  minOutOverrides: new Map([[loser, 999n]]), // optional, per loser
  minWinnerTokensRollover: 0n,
  minWinnerTokensPol: 0n,
});
// result.{submitTx, liquidateTxs[], finalizeTx}
```

### Phase arc

```ts
import {startSeason, runPhaseArc, Phase, advancePhase} from "@filter-fun/scheduler";

await startSeason(driver, launcherAddress);
// ... users launch tokens; off-chain scoring picks finalists ...

// Drive the oracle-orchestrated arc in one call:
await runPhaseArc(driver, launcherAddress, seasonId, finalistAddrs);
//   → advancePhase(Filter) → setFinalists → advancePhase(Finals) → advancePhase(Settlement)

// Or step-by-step:
await advancePhase(driver, launcherAddress, seasonId, Phase.Closed);
```

`driver` is a narrow interface — `{ writeContract, waitForReceipt }` — so production code passes viem's `WalletClient` + `PublicClient` and tests pass mocks. The package itself stays off the network.

For one-off batches (e.g. submitting through a Safe), use the lower-level builders directly:

```ts
import {submitSettlementCall, liquidateCall, finalizeCall, claimRolloverCall} from "@filter-fun/scheduler";
const call = submitSettlementCall(vault, payload); // {address, abi, functionName, args}
```

### Bonus arc

```ts
import {postBonusRoot, claimBonus} from "@filter-fun/scheduler";
import {buildBonusPayload} from "@filter-fun/oracle";

const payload = buildBonusPayload({snapshots, rolledByHolder, totalReserve});

// Oracle: post the root once the 14-day window has elapsed.
await postBonusRoot(driver, bonusDistributor, seasonId, payload);

// Holder (or batch script): claim with their precomputed (amount, proof).
const entry = payload.entries.find((e) => e.user === holder)!;
await claimBonus(driver, bonusDistributor, seasonId, entry.amount, entry.proof);
```

Or use the lower-level builders: `postBonusRootCall`, `claimBonusCall`.

## Sequencing

- `submitSettlement` gates everything else (vault enters `Liquidating`).
- Liquidations run **sequentially**. Trivial nonce management; if you want parallelism, use `liquidateCall` directly and manage nonces yourself.
- `finalize` waits for every liquidation receipt — running it before they mine reverts on `Phase != Aggregating`.

## Cadence

The scheduler library doesn't fire timers — it's a transaction driver — so the harness invoking it (k8s cron / Railway / manual ops) decides *when* to call each phase advance. The hour anchors live in `@filter-fun/cadence` and are re-exported from this package as a single entrypoint:

```ts
import {DEFAULT_CADENCE, loadCadence, hoursToSec, advancePhase, Phase} from "@filter-fun/scheduler";

// Read from env (validated at startup); falls back to DEFAULT_CADENCE.
const cadence = loadCadence();

// Schedule advances at season.startedAt + N hours:
//   launchEndHour (48)  — close launch
//   hardCutHour   (96)  — 12 → 6 hard cut
//   settlementHour(168) — final settlement
const dueAtSec = startedAtSec + hoursToSec(cadence.hardCutHour);
```

Override via env (`SEASON_HARD_CUT_HOUR=…`, etc.) — see [`packages/cadence/README.md`](../cadence/README.md). Bad values fail loudly at startup. **No Day 5 soft filter** — `softFilterEnabled` defaults to `false` (spec §33.6 resolved off); kept for forward compatibility.

## Out of scope (next iteration)

- Retry / replacement-tx logic for stuck transactions.
- Multi-signer Safe payload bundling.
- A timer harness — when filter.fun adopts a specific scheduler runtime (k8s cron, Railway, etc.), wire it to read from `loadCadence()` and call `advancePhase()` at the anchors above.

## Tests

```sh
npm --workspace @filter-fun/scheduler run test
```
