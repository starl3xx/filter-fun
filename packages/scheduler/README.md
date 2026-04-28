# @filter-fun/scheduler

Drives the on-chain settlement loop. Consumes `@filter-fun/oracle`'s `SettlementPayload`, sequences the txns through `SeasonVault`:

1. `submitSettlement(winner, losers, minOuts, root, totalShares, deadline)` — oracle-only
2. `liquidate(loser, minOutOverride)` — once per loser, permissionless
3. `finalize(minRolloverOut, minPolOut)` — allocates the pot, AMM-buys winner tokens

## API

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

- Phase-advance driver (`launcher.advancePhase` for Launch → Filter → Finals → Settlement).
- Bonus-snapshot driver (`BonusDistributor.postRoot` after the 14-day window).
- Retry / replacement-tx logic for stuck transactions.
- Multi-signer Safe payload bundling.

## Tests

```sh
npm --workspace @filter-fun/scheduler run test
```
