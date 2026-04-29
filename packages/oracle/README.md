# @filter-fun/oracle

Oracle payload builder. Consumes the indexer's per-token holder snapshots + the scoring engine's ranking, produces:

1. The **settlement calldata** that the multisig posts to `SeasonVault.submitSettlement`:
   - `winner` (address)
   - `losers[]`, `minOuts[]` — TWAP-floored slippage guards per loser
   - `rolloverRoot` (bytes32)
   - `totalRolloverShares` (uint256)
   - `liquidationDeadline` (uint256)
2. A **rollover Merkle tree** (sidecar) keyed by user address, with proofs ready for the claim UI.

## Why "share" and not "amount"

`SeasonVault.finalize` buys winner tokens with the rollover slice via the AMM — its output is only known *after* settlement. The oracle therefore commits to **abstract shares** at settlement time. At claim time, payout is `share × rolloverWinnerTokens / totalRolloverShares`. Leaves are `keccak256(abi.encodePacked(user, share))` — matching `SeasonVault.claimRollover`.

## API

```ts
import {buildSettlementPayload} from "@filter-fun/oracle";

const payload = buildSettlementPayload({
  ranking: ["0xWinner...", "0xLoserA...", "0xLoserB..."],
  recoverable: new Map([
    ["0xLoserA...", 1_500_000_000_000_000_000n], // WETH raw units (1.5 ETH)
    ["0xLoserB...", 2_500_000_000_000_000_000n], // 2.5 ETH
  ]),
  slippageBps: 250, // 2.5%
  shares: new Map([
    ["0xAlice...", 60n],
    ["0xBob...", 40n],
  ]),
  liquidationDeadline: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
});

// payload.{winner, losers, minOuts, rolloverRoot, totalRolloverShares, liquidationDeadline}
// → submitSettlement calldata
// payload.tree.entries: per-user {user, share, proof[]} for the claim UI
```

The Merkle tree uses sorted-pair hashing (OZ `MerkleProof`-compatible), so proofs verify against `bytes32 leaf = keccak256(abi.encodePacked(msg.sender, share))`.

## Bonus payload

The 14-day hold bonus runs the same Merkle pattern, with **concrete WETH amounts** at the leaves rather than abstract shares — the bonus reserve is known at finalize time, so we can pre-allocate.

```ts
import {buildBonusPayload} from "@filter-fun/oracle";

const payload = buildBonusPayload({
  // 3–5 unannounced snapshots taken across the 14-day hold window.
  snapshots: [
    new Map([["0xAlice...", 100n], ["0xBob...", 50n]]),
    new Map([["0xAlice...", 95n], ["0xBob...", 49n]]),
    new Map([["0xAlice...", 100n], ["0xBob...", 50n]]),
  ],
  // Per-holder rolledAmount (winner tokens received via claimRollover).
  rolledByHolder: new Map([["0xAlice...", 100n], ["0xBob...", 60n]]),
  // BonusDistributor.bonusOf(seasonId).reserve.
  totalReserve: 1_000_000_000_000_000_000n, // 1 WETH
  holdThresholdBps: 8000, // optional, default 80%
});

// payload.{root, entries[{user, amount, proof}], totalAllocated}
//   → root: pass to BonusDistributor.postRoot(seasonId, root)
//   → entries[i]: claim data for the web app
```

Eligibility is `min(balance across snapshots) ≥ thresholdBps × rolledAmount / 10_000`. Allocation among eligible holders is pro-rata by `rolledAmount`. Leaves are `keccak256(abi.encodePacked(user, amount))` — matches `BonusDistributor.claim`.

## Tests

```sh
npm --workspace @filter-fun/oracle run test
```

## Out of scope (next module)

- Multisig signing / EIP-712 wrapper around the payload.
- Direct `viem` `walletClient.writeContract` driver — that's the scheduler's job.
