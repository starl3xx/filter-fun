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

## Publishing claim entries

Both payload builders return Merkle trees keyed by user. To publish per-user JSON for the web app's claim flow, use the publication helpers:

```ts
import {splitSettlementForPublication, splitBonusForPublication} from "@filter-fun/oracle";

const rolloverEntries = splitSettlementForPublication(settlementPayload, vaultAddress, seasonId);
//   → {"0xalice…": {seasonId, vault, share, proof}, "0xbob…": {…}, …}

const bonusEntries = splitBonusForPublication(bonusPayload, distributorAddress, seasonId);
//   → {"0xalice…": {seasonId, distributor, amount, proof}, …}
```

Bigints serialize as decimal strings (JSON has no native bigint). Keys are lowercase addresses; the web app's claim form parses these directly.

## Tests

```sh
npm --workspace @filter-fun/oracle run test
```

## Canonical HP ranking algorithm (Epic 1.18)

The oracle's HP ranking Merkle (`buildHpRankingPayload`) consumes pre-ranked
entries supplied by the indexer; it does **not** re-derive the ordering. The
canonical ranking algorithm — which the indexer applies via the `score()` call
in `@filter-fun/scoring` — is:

1. **Primary key**: integer composite HP, descending. The composite scale is
   `[0, 10000]` (spec §6.5; bumped from float `[0, 1]` in Epic 1.18).
2. **Secondary key (tie-break)**: `launchedAt` (`token.createdAt` from the
   indexer), ascending — earlier-launched wins.

Why a tie-break: with a 10001-value integer scale, exact-HP ties are uncommon
but not impossible (especially in degenerate cohorts or with a small number of
contributing components active). Without the secondary key, two tied tokens
would resolve to whatever order `Array.sort`'s stable behavior produced from
the input — fine for replays of the same input but ambiguous when the indexer
re-reads cohorts back from the DB in a different order. Earlier-launched
wins because longevity is a weak signal of legitimacy and the choice is
public, predictable, and contract-immaterial (the on-chain settlement reads
the oracle-posted Merkle root, not HP values directly).

The Merkle build itself sorts its leaves by `(rank ASC, token ASC)` — a
deterministic ordering over the already-ranked input — so the root is
reproducible regardless of how the indexer returned the rows.

## Out of scope (next module)

- Multisig signing / EIP-712 wrapper around the payload.
- Direct `viem` `walletClient.writeContract` driver — that's the scheduler's job.
