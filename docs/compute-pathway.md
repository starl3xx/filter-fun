# HP Compute Pathway — Cadence, Triggers, Settlement Provenance

How filter.fun gets from "swap event landed on Base" to "Arena leaderboard
shows the new HP within 5 seconds" — and how settlement-authoritative
snapshots get tied to the on-chain cut/finalize calls.

> **Spec refs**: §6.5 (locked weights), §6.8 (this document — compute pathway),
> §42.2.6 (oracle authority invariant).

> **Audience**: oncall operator monitoring HP-engine health, external auditor
> verifying that a settlement's ranking matches a published Merkle root.

---

## 1. Recompute triggers

Every `hpSnapshot` row carries a `trigger` column. Six values, each with
distinct semantics:

| Trigger | Source | Cadence | Cohort |
|---|---|---|---|
| `BLOCK_TICK` | Periodic block-interval handler | Every ~150 blocks (≈5 min on Base) | All tokens |
| `SWAP` | V4 PoolManager `Swap` event handler | Per swap, with 1s coalescing | One token |
| `HOLDER_SNAPSHOT` | FilterToken `Transfer` event handler | Per balance change, with 1s coalescing | One token |
| `PHASE_BOUNDARY` | Scheduler | h0 / 24 / 48 / 72 (±10s) | All tokens |
| `CUT` | Scheduler | h96 ±10s | All tokens (settlement-authoritative) |
| `FINALIZE` | Scheduler | h168 ±10s | All tokens (settlement-authoritative) |

**Why six triggers, not one.** Per-token triggers (`SWAP`,
`HOLDER_SNAPSHOT`) fire on every event that meaningfully changes the
component inputs for that token: a swap shifts velocity / sticky-liquidity
inputs, a balance transfer shifts holder concentration. Cohort-wide triggers
(`PHASE_BOUNDARY`, `CUT`, `FINALIZE`) recompute every token's HP at once
because rank-relative components (velocity / effective-buyers / sticky-liq
min-max) are affected by the cohort distribution. `BLOCK_TICK` is the
periodic floor that ensures rows exist for tokens with no recent activity.

---

## 2. Latency budget (≤5s end-to-end)

```
swap → block confirmation         ~2s    (Base block time)
swap → indexer handler            <1s
indexer handler → hpSnapshot row  <1s    (with coalescing)
                                  ──────
                                  swap-to-row budget: 3s
hpSnapshot row → /season API      <1s    (LRU cache hit; cache invalidated on write)
hpSnapshot row → SSE HP_UPDATED   <1s    (fanout via in-memory hub)
                                  ──────
                                  total budget: 5s
```

The indexer wraps the `swap-recompute` and `holder-recompute` paths in a
`withLatencySla` instrumented helper (see
`packages/indexer/src/api/coalescing.ts`). A 5s breach emits a structured
warning log:

```json
{"level":"warn","label":"swap-recompute","elapsedMs":5234,"slaMs":3000}
```

Operators alarm on these in the operator runbook §2.1.

---

## 3. Coalescing (per-token 1s window)

Bursty trade activity (think 100 swaps in 30s during a hot launch) would
otherwise produce 100 nearly-identical hpSnapshot rows + 100 SSE
HP_UPDATED frames. The coalescing rule:

> If an `hpSnapshot` row exists for `(token, ts ≥ blockTimestamp - 1s)`,
> the new write is skipped.

Implemented via a SQL pre-check in `recomputeAndStampHp`
(`packages/indexer/src/api/hpRecomputeWriter.ts`). The window is in
**block-time** (not wall-clock), so historical replay collapses bursts
naturally and real-time mode applies the rule against the live block
stream.

A timer-based debounce scheduler is intentionally *not* used here:
Drizzle's `context.db` is transaction-scoped and would be invalid by the
time a deferred timer fires. The SQL pre-check is the only coalescing
mechanism on this path. The wall-clock-driven `hpPhaseRecompute`
scheduler module uses idempotent `firedFor` state for deduplication
rather than a debounce queue.

---

## 4. Settlement-authoritative path (CUT + FINALIZE)

The two settlement-authoritative anchors fire from the scheduler, not the
indexer's event handlers — they're tied to wall-clock boundaries
(h96 / h168), not to any specific transaction:

```
Scheduler tick at t = startedAt + 96h ± 10s
  ↓
  POST /internal/recompute  (trigger=CUT, seasonId=N)
  ↓
Indexer: recomputeAndStampHp({trigger: "CUT", ...})
  ↓
Indexer writes one hpSnapshot row per token, all tagged trigger=CUT
  ↓
Oracle reads the CUT rows, calls buildHpRankingPayload() (Merkle tree)
  ↓
Oracle pins the tree to IPFS
  ↓
Oracle posts the root on-chain via setOracle / setRoot
  ↓
Operator calls SeasonVault.cut() — contract reads the oracle-posted root
```

**The order is invariant.** The contract reads the oracle-posted root, not
the per-component scores (spec §42.2.6 oracle-authority). If the scheduler
fires CUT *after* the operator calls `SeasonVault.cut()`, the cut would
have used a stale root — the `checkSettlementProvenance` helper in the
oracle (see `packages/oracle/src/hpRankingProvenance.ts`) pins the
ordering at the JS level. A Foundry invariant
(`inv_settlement_hp_snapshot_provenance`, deferred to a follow-up PR
that wires the indexer-state fixture) extends the check to the contract
side.

### Merkle leaf format

```solidity
keccak256(abi.encode(seasonId, token, rank, hp, keccak256(bytes(weightsVersion))))
```

Every field that drove the ranking decision, packed deterministically.
`weightsVersion` is hashed to a 32-byte value so the encoding stays
fixed-width regardless of version-string length.

A trader who wants to prove they were ranked above the cut line at h96
can supply the leaf + proof against the on-chain root — the same
affordance the rollover Merkle already provides.

---

## 5. SSE: HP_UPDATED event

Every `hpSnapshot` row write fires one HP_UPDATED event onto the indexer's
`/events` SSE stream. Wire shape (`TickerEvent` typed in
`packages/indexer/src/api/events/types.ts`):

```json
{
  "id": 12345,
  "type": "HP_UPDATED",
  "priority": "LOW",
  "token": "$EDGE",
  "address": "0x…",
  "message": "",
  "data": {
    "hp": 8700,
    "components": {
      "velocity": 0.5,
      "effectiveBuyers": 0.3,
      "stickyLiquidity": 0.7,
      "retention": 0.9,
      "momentum": 0,
      "holderConcentration": 0.4
    },
    "weightsVersion": "2026-05-04-v4-locked-int10k-formulas",
    "computedAt": 1714521600,
    "trigger": "SWAP"
  },
  "timestamp": "2026-05-05T10:30:00.000Z"
}
```

> **Epic 1.18 — composite scale.** `hp` is integer in `[0, 10000]` (was
> 0-100 pre-int10k cutover). Same effective resolution as the prior
> 0-100 with two decimal places, but cleaner storage and aligned with
> the BPS convention used elsewhere in the protocol. Clients gating on
> absolute thresholds were updated in lockstep with the indexer.

`priority: "LOW"` — HP_UPDATED is data refresh, not a ticker line; the
hub sheds it first under backpressure, which preserves HIGH events
(CUT_LINE_CROSSED, FILTER_FIRED) for slow clients. The empty `message`
signals to ticker-UI consumers that no ticker line should be rendered;
data consumers (Arena leaderboard, per-token detail) read `data` directly.

Per-token filtered SSE (`/events?token=0x...`) is **not** implemented in
this PR; it's part of 1.17c's frontend-side scope (the web app's
per-token detail page subscribes to a filtered stream). The unfiltered
stream is hub-broadcast; clients filter client-side until 1.17c lands.

---

## 6. What to monitor (oncall)

Beyond §2.1 of the operator runbook, two new alarms ship with this epic:

**Latency-SLA breach** — `[hp-recompute] SLA breach` warning lines on the
indexer container. Threshold: 3s for swap/holder recompute, 5s end-to-end.

**Trigger-version drift** — every `hpSnapshot` row carries `trigger` and
`weightsVersion`. Operator dashboard alarm: any row tagged
`trigger='CUT'` or `'FINALIZE'` whose `weightsVersion` doesn't match the
live `HP_WEIGHTS_VERSION` is a deploy-coordination bug — settlement is
about to fire under unexpected weights.

---

## 7. Known limitations (this PR)

This PR ships the in-CI-testable pieces:

- Schema + writer + handler wiring (swap, holder, block-tick)
- Pure-function helpers for coalescing, phase-boundary scheduling, oracle
  Merkle provenance
- SSE event-type extension

Deferred to a follow-up PR (1.17b-extension or 1.17d) that requires a
live deploy + integration fixtures:

- Sepolia smoke run of the end-to-end ≤5s budget across 10 test runs
- Foundry invariant `inv_settlement_hp_snapshot_provenance` against an
  indexer-state fixture
- 100-swap stress test verifying coalescing on real blockchain time
- Oracle's `/internal/recompute` HTTP endpoint on the indexer side (the
  scheduler's webhook target — currently the scheduler module exposes a
  pure dispatcher with an injected webhook callable)

---

## 8. References

- `packages/indexer/src/api/hpRecompute.ts` — pure helpers (event payload, row construction, trigger taxonomy)
- `packages/indexer/src/api/hpRecomputeWriter.ts` — the impure writer + per-token coalescing
- `packages/indexer/src/api/coalescing.ts` — latency-SLA wrapper (per-token coalescing lives in the writer's SQL pre-check)
- `packages/indexer/src/api/events/hpBroadcast.ts` — HP_UPDATED broadcast bridge from Ponder handlers to the SSE hub
- `packages/indexer/src/V4PoolManager.ts` — swap handler wiring
- `packages/indexer/src/FilterToken.ts` — Transfer handler wiring
- `packages/indexer/src/HpSnapshot.ts` — block-tick handler (refactored to use the shared writer)
- `packages/scheduler/src/hpPhaseRecompute.ts` — phase-boundary scheduler module
- `packages/oracle/src/hpRankingProvenance.ts` — Merkle root + ordering invariant
- `docs/scoring-weights.md` — weight set the compute pathway scores against
- `docs/runbook-operator.md` §2.1 — what to monitor
