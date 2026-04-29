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

## Sequencing

- `submitSettlement` gates everything else (vault enters `Liquidating`).
- Liquidations run **sequentially**. Trivial nonce management; if you want parallelism, use `liquidateCall` directly and manage nonces yourself.
- `finalize` waits for every liquidation receipt — running it before they mine reverts on `Phase != Aggregating`.

## Out of scope (next iteration)

- Bonus-snapshot driver (`BonusDistributor.postRoot` after the 14-day window).
- Retry / replacement-tx logic for stuck transactions.
- Multi-signer Safe payload bundling.

## Tests

```sh
npm --workspace @filter-fun/scheduler run test
```
