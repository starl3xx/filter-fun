# Zombie tokens — tradability after filter

**Status:** policy locked 2026-04-30 (spec §36.1.2)

## Policy

Filtered tokens remain **tradable indefinitely** on Uniswap V4. The filter.fun protocol does **not**:

- disable swaps on a filtered token's V4 pool,
- remove the pool,
- pause the V4 PoolManager,
- impose any swap fee tax that would amount to a soft kill.

A filtered token's pool experiences high slippage immediately after the cut (because the unwind step removes the bonded LP that was sustaining tight quotes), and over time the token typically loses what residual liquidity remains. But the on-chain trading right is untouched. Filtered tokens may be traded by anyone, may organically revive, and may even continue to generate trickle creator/protocol fees.

## Why

Three reasons. None alone would be decisive; together they are.

1. **Credibility.** "filter.fun seizes your trading rights when your token loses" would be a contract no creator should sign and no buyer should trust. Filter is a competitive cut, not a seizure. The pool keeps existing because the pool was never the protocol's to destroy.

2. **Long-tail fees.** Residual trading on filtered tokens still routes the standard creator + protocol + champion-bounty fees through `CreatorFeeDistributor`. The amounts are usually small per token, but they're free money for the treasury at zero ongoing cost — it would be perverse to design those fees away.

3. **Emergent narratives.** A filtered token that organically revives is its own story — the kind of thing a long-tail-winner page (Phase 3) gets to celebrate. Locking the door at filter time would foreclose this.

## How it's enforced in code

This is enforced **structurally** — by the absence of a "disable trading" code path — rather than as a runtime flag. Verified 2026-04-30 against the genesis contracts:

- `FilterHook.sol` registers only `beforeAddLiquidity` + `beforeRemoveLiquidity` flags (line 38 and 40 of the constructor); `beforeSwap`, `afterSwap`, etc. are all `false`. The hook **cannot** intercept a swap on a filtered pool.
- `FilterLauncher.sol` is `Pausable` (line 30), but the pause guard only protects launch-side calls (`startSeason`, `advancePhase`, `launch`, `setFinalists` — every `whenNotPaused` is on a launcher entry point, never on the V4 PoolManager). Pausing the launcher stops new launches; it does not affect existing pools.
- The `SeasonVault` / settlement engine has no method that disables a pool, removes a pool, or imposes a swap-time tax. The unwind step (`liquidate(loser)`) calls back into V4 to remove the protocol-bonded LP only.

If a future PR adds a code path that would disable trading on a filtered pool, treat it as a P0 contract bug under spec §36.1.2.

## Operator guidance

When fielding "the token I bought got filtered, what happened?" questions:

- Yes, you can still trade it. Connect to Uniswap directly (the protocol pool is the same one your wallet shows).
- Slippage will be much higher than during the active week because the protocol-bonded liquidity is gone. Trade small or wait for organic LPs to re-add liquidity.
- Most filtered tokens fade. Some don't. The protocol takes no position on which.

## Related

- Spec §36.1.2 — zombie-tradability policy
- Spec §3.2 — recommended season timeline
- Spec §36.1.5 — filter timing explicit cadence
- `packages/cadence/` — single source of truth for filter cadence (when the cut happens)
- Future: long-tail-winner page (Phase 3) will surface revived zombies as standalone stories.
