import {ponder} from "@/generated";

import {pool, swap, token as tokenTable} from "../ponder.schema";
import {readDeployment, type ChainNetwork} from "./deployment.js";
import {recomputeAndStampHp} from "./api/hpRecomputeWriter.js";
import {withLatencySla} from "./api/coalescing.js";
import {broadcastHpUpdated} from "./api/events/hpBroadcast.js";

/// V4 PoolManager `Swap` handler. Filters chain-wide Swap events down to filter.fun
/// pools by joining `Swap.id` (a `PoolId` = bytes32) against our `pool` table. Foreign
/// pool swaps short-circuit before any DB write.
///
/// V4 swap-event semantics:
///   - `amount0` / `amount1` are signed `int128` deltas measured FROM the pool's
///     perspective. Positive → token flowed INTO the pool. Negative → token flowed
///     OUT of the pool.
///   - The pool's currencies are `currency0` and `currency1`, sorted by lowercase
///     address (V4 invariant). Our pools always pair the FilterToken with WETH; the
///     ordering depends on whose address sorts first.
///   - From the trader's perspective, BUY = pool received WETH and sent FilterToken.
///     SELL = pool received FilterToken and sent WETH.
///
/// We resolve the WETH leg from the deployment manifest (preferred) or the
/// `WETH_ADDRESS` env override. On Base mainnet WETH < FilterToken in 99% of pools
/// (WETH is 0x4200…0006), so currency0 = WETH and the BUY signal is `amount0 > 0`.
/// We don't hard-code the assumption — `wethIsToken0` is determined per-token-pair
/// below.
///
/// `taker` (Epic 1.22b): we use `event.transaction.from` — the EOA that signed
/// and submitted the transaction — instead of `event.args.sender` (the address
/// that called `unlock()`, typically the universal router under V4). The
/// HP scoring projection's velocity / effective-buyers components key off
/// per-wallet attribution, and using the router's address would bucket every
/// trader into the same hot wallet and zero out the per-wallet signal.
///
/// `tx.from` correctly resolves to the user's wallet for direct + universal-
/// router calls. The remaining edge case is meta-tx relayers (a third party
/// pays gas on behalf of a user) — for those, full router decoding is needed
/// to recover the originating EOA. Out of scope for filter.fun's genesis
/// flow; can be retrofitted without a schema change when Track D lands.

/// WETH address resolution. Bugbot caught a silent-corruption path: when
/// `WETH_ADDRESS` was unset the previous implementation fell back to the zero
/// address. `0x000…000` sorts BELOW any real token address, so `wethIsToken0`
/// became unconditionally true — on every pool where the FilterToken sorts below
/// real WETH, the leg-assignment swapped silently and `wethValue` was filled with
/// the token amount (and vice versa), permanently corrupting
/// `lifetimeTradeVolumeWei` aggregation for affected pools.
///
/// Resolution is lazy (first-handler-call) rather than at module-import time so
/// `ponder codegen` — which imports handler modules in environments that may not
/// have WETH_ADDRESS / a deploy manifest configured — still succeeds. The throw
/// fires the first time a Swap event would actually be written, which is the
/// earliest moment we'd otherwise emit corrupted data. A missing WETH address at
/// runtime is operator misconfiguration; failing loud beats silently mislabeling
/// every BUY as a SELL on half the cohort.
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
let WETH_CACHED: `0x${string}` | null = null;
function resolveWeth(): `0x${string}` {
  if (WETH_CACHED) return WETH_CACHED;
  const network = (process.env.PONDER_NETWORK ?? "baseSepolia") as ChainNetwork;
  const fromManifest = readDeployment(network).addresses.weth;
  const fromEnv = (process.env.WETH_ADDRESS ?? "").toLowerCase();
  const resolved =
    fromEnv ||
    (fromManifest && fromManifest !== ZERO_ADDR ? fromManifest.toLowerCase() : "");
  if (!resolved || resolved === ZERO_ADDR) {
    throw new Error(
      "[indexer] WETH address unresolved. Set WETH_ADDRESS or supply a deployment " +
        "manifest with addresses.weth populated — V4PoolManager swap indexing cannot " +
        "safely resolve trader-perspective legs without it (silent BUY/SELL + " +
        "wethValue/tokenAmount corruption otherwise).",
    );
  }
  WETH_CACHED = resolved as `0x${string}`;
  return WETH_CACHED;
}

ponder.on("V4PoolManager:Swap", async ({event, context}) => {
  const poolId = event.args.id as `0x${string}`;
  const poolRow = await context.db.find(pool, {id: poolId});
  if (!poolRow) return; // foreign pool — drop.

  // Resolve token0/token1 ordering by reading the FilterToken address vs WETH.
  // V4 sorts currencies lowercase; we replicate that here without an extra
  // round-trip to `PoolManager.poolKeys()`. Throws on misconfiguration before any
  // row write — see the resolveWeth doc above.
  const filterToken = poolRow.token.toLowerCase() as `0x${string}`;
  const weth = resolveWeth();
  const wethIsToken0 = weth < filterToken;

  // Pool-perspective signed deltas → trader-perspective unsigned legs.
  const amount0 = event.args.amount0;
  const amount1 = event.args.amount1;
  const wethDelta = wethIsToken0 ? amount0 : amount1;
  const tokenDelta = wethIsToken0 ? amount1 : amount0;

  // BUY: trader paid WETH (delta into pool > 0) and received FilterToken (delta out
  // of pool < 0). SELL inverts. Tie-break on zero is unreachable in well-formed
  // V4 swaps (one side is always non-zero).
  const side: "BUY" | "SELL" = wethDelta > 0n ? "BUY" : "SELL";
  const wethValue = wethDelta < 0n ? -wethDelta : wethDelta;
  const tokenAmount = tokenDelta < 0n ? -tokenDelta : tokenDelta;

  // Defensive: don't write a row for a pool whose token doesn't exist in our
  // `token` table. Shouldn't happen — `pool` is populated by `FilterFactory.TokenDeployed`
  // which fires after `FilterLauncher.TokenLaunched`. Belt + braces.
  const tokenRow = await context.db.find(tokenTable, {id: poolRow.token});
  if (!tokenRow) return;

  await context.db.insert(swap).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    poolId,
    token: poolRow.token,
    // Epic 1.22b — see module doc above. `tx.from` is the EOA, not the router.
    taker: event.transaction.from,
    side,
    wethValue,
    tokenAmount,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });

  // Epic 1.17b — fire HP recompute on every swap. Per-token 1s coalescing
  // happens inside `recomputeAndStampHp` (skips if a recent row exists for
  // this token within the past second of block-time). Latency SLA: the full
  // path should fit in ≤3s; logging here surfaces a warning if it doesn't.
  await withLatencySla("swap-recompute", 3000, async () => {
    await recomputeAndStampHp(context, {
      tokenAddress: poolRow.token,
      trigger: "SWAP",
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      onWritten: broadcastHpUpdated,
    });
  });
});
