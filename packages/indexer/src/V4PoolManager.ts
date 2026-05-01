import {ponder} from "@/generated";

import {pool, swap, token as tokenTable} from "../ponder.schema";

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
/// We resolve the WETH leg by reading `WETH_ADDRESS` from env (set by the deploy
/// manifest). On Base mainnet WETH < FilterToken in 99% of pools (WETH is
/// 0x4200…0006), so currency0 = WETH and the BUY signal is `amount0 > 0`. We don't
/// hard-code the assumption — `wethIsToken0` is determined per-token-pair below.
///
/// `taker`: V4 emits `sender` = the address that called `unlock()`. With the
/// universal router that's the router itself, not the EOA. We surface `sender` here
/// because it's what the contract emits — `/profile.stats.lifetimeTradeVolumeWei`
/// ultimately wants the EOA, so when we wire up router decoding (Track D — out of
/// scope for this PR) we can backfill the EOA without changing the schema.

const WETH_ADDR_ENV = (process.env.WETH_ADDRESS ?? "").toLowerCase();

ponder.on("V4PoolManager:Swap", async ({event, context}) => {
  const poolId = event.args.id as `0x${string}`;
  const poolRow = await context.db.find(pool, {id: poolId});
  if (!poolRow) return; // foreign pool — drop.

  // Resolve token0/token1 ordering by reading the FilterToken address vs WETH.
  // V4 sorts currencies lowercase; we replicate that here without an extra
  // round-trip to `PoolManager.poolKeys()`.
  const filterToken = poolRow.token.toLowerCase() as `0x${string}`;
  const weth = (WETH_ADDR_ENV || "0x0000000000000000000000000000000000000000") as `0x${string}`;
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
    taker: event.args.sender,
    side,
    wethValue,
    tokenAmount,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});
