/// FilterLauncher event handlers.
///
/// Spec §46.9 — deferred-activation launch model:
///   SeasonStarted    → row in `season` + `vaultSeason` + `launchEscrowSummary`
///   TokenLaunched    → row in `token`; mark matching reservation `RELEASED`
///   PhaseAdvanced    → mutate `season.phase` + log `phaseChange`
///   FinalistsSet     → set `isFinalist=true` on the listed tokens (decoded from calldata)
///   SeasonActivated  → flip `launchEscrowSummary.activated=true`
///   SeasonAborted    → flip `launchEscrowSummary.aborted=true` + cascade reservation status
///                       (the per-creator refund accounting fires from LaunchEscrow handlers)
///   TickerBlocked    → row in `tickerBlocklist`
///   WinnerTickerReserved → row in `winnerTickerReservation`
///
/// **FinalistsSet** carries only `seasonId` (Epic 1.15a — the lean event the launcher
/// emits to fit the EIP-170 budget). The full finalist list is recovered from the
/// transaction calldata via `decodeFunctionData(setFinalists)`. Tradeoff: indexers MUST
/// see the full transaction (Ponder does); a client that only consumed event logs would
/// need a chain read against `entryOf(seasonId, token).isFinalist` for every token in
/// the season, which is what the `LauncherLens.allEntries` getter is for.

import {ponder} from "@/generated";
import {eq} from "@ponder/core";
import {decodeFunctionData, encodeAbiParameters} from "viem";

import {broadcastSeasonStateEvent} from "./api/events/launchBroadcast.js";
import {
  launchEscrowSummary,
  operatorActionLog,
  phaseChange,
  reservation,
  season,
  seasonTickerReservation,
  tickerBlocklist,
  token,
  vaultSeason,
  winnerTickerReservation,
} from "../ponder.schema";
import {FilterLauncherAbi} from "../abis/FilterLauncher";

const PHASE_NAMES = ["Launch", "Filter", "Finals", "Settlement", "Closed"] as const;

ponder.on("FilterLauncher:SeasonStarted", async ({event, context}) => {
  await context.db.insert(season).values({
    id: event.args.seasonId,
    startedAt: event.block.timestamp,
    vault: event.args.vault,
    phase: "Launch",
  });
  await context.db.insert(vaultSeason).values({
    vault: event.args.vault,
    seasonId: event.args.seasonId,
  });
  // Bootstrap the per-season escrow summary so subsequent reservation events can
  // increment without an upsert race. `activated`/`aborted` default to false.
  await context.db.insert(launchEscrowSummary).values({
    id: event.args.seasonId,
  });
});

ponder.on("FilterLauncher:TokenLaunched", async ({event, context}) => {
  // Audit: bugbot M PR #92. Lowercase `creator` at write time so cross-table joins
  // against `reservation.creator` (already lowercased) compare equal, and so
  // `/profile/:address` queries — which lowercase the URL param — match. Same
  // bug class as the round-5 pendingRefund fix; applying it here rounds out the
  // canonical-address invariant across every Epic 1.15a-touched table.
  const creator = event.args.creator.toLowerCase() as `0x${string}`;
  await context.db.insert(token).values({
    id: event.args.token,
    seasonId: event.args.seasonId,
    symbol: event.args.symbol,
    name: event.args.name,
    metadataUri: event.args.metadataURI,
    creator,
    locker: event.args.locker,
    isProtocolLaunched: event.args.isProtocolLaunched,
    createdAt: event.block.timestamp,
  });

  // Reservation lifecycle: mark the matching `(seasonId, creator)` reservation
  // RELEASED and pin the launched token address. Protocol-token launches DON'T
  // have a matching reservation (FILTER bypasses the escrow), so the upsert
  // is conditional on whether a row exists — `update` would fail silently
  // otherwise. We use `find` first to avoid the upsert path for protocol launches.
  const reservationId = `${event.args.seasonId.toString()}:${creator}`;
  const existing = await context.db.find(reservation, {id: reservationId});
  if (existing) {
    await context.db
      .update(reservation, {id: reservationId})
      .set({
        status: "RELEASED",
        resolvedAt: event.block.timestamp,
        token: event.args.token,
      });
    // Increment summary's `totalReleased`. The escrow amount stays in
    // `totalEscrowed` — `totalReleased` tracks how much normalized into a
    // launched token (vs. refunded / forfeited).
    const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
    if (summary) {
      await context.db
        .update(launchEscrowSummary, {id: event.args.seasonId})
        .set({totalReleased: summary.totalReleased + existing.escrowAmount});
    }
  }
});

ponder.on("FilterLauncher:PhaseAdvanced", async ({event, context}) => {
  const newPhase = PHASE_NAMES[Number(event.args.newPhase)] ?? "Unknown";
  await context.db
    .update(season, {id: event.args.seasonId})
    .set({phase: newPhase});
  await context.db.insert(phaseChange).values({
    id: `${event.args.seasonId.toString()}:${event.log.logIndex}`,
    seasonId: event.args.seasonId,
    newPhase,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("FilterLauncher:FinalistsSet", async ({event, context}) => {
  // The lean event carries only `seasonId` — the finalist list isn't on the wire.
  //
  // Audit: bugbot M PR #92 round 3. The earlier calldata-decode-only path silently
  // failed when the oracle was a Gnosis Safe (or any proxy): `event.transaction.input`
  // is then `execTransaction(...)` calldata, NOT `setFinalists(...)` calldata, and
  // `decodeFunctionData` either threw or returned the wrong selector — leaving every
  // token's `isFinalist` permanently false.
  //
  // Robust strategy:
  //   1. Try the calldata decode (works for EOA oracle — zero RPC cost).
  //   2. If decode yields the wrong selector OR the embedded seasonId doesn't match
  //      the event's seasonId, fall back to a chain read against `entryOf(seasonId, token)`
  //      for every token in the season's cohort. ≤12 reads per season — bounded by
  //      the launcher's `MAX_LAUNCHES`.
  const seasonId = event.args.seasonId;

  let finalistsFromCalldata: readonly `0x${string}`[] | null = null;
  try {
    const decoded = decodeFunctionData({
      abi: FilterLauncherAbi,
      data: event.transaction.input,
    });
    if (decoded.functionName === "setFinalists") {
      const [decodedSeasonId, decodedFinalists] = decoded.args as [
        bigint,
        readonly `0x${string}`[],
      ];
      // Defence against a future refactor where the function arg order changes
      // OR the event fires from a different (relay) function with the same selector.
      if (decodedSeasonId === seasonId) {
        finalistsFromCalldata = decodedFinalists;
      }
    }
  } catch {
    // Outer calldata isn't a `setFinalists(...)` call — likely a multisig wrapping
    // (Gnosis Safe execTransaction, Timelock, etc). Fall through to chain-read.
  }

  if (finalistsFromCalldata !== null) {
    for (const finalistAddr of finalistsFromCalldata) {
      const existing = await context.db.find(token, {id: finalistAddr});
      if (!existing) continue;
      await context.db.update(token, {id: finalistAddr}).set({isFinalist: true});
    }
    return;
  }

  // Chain-read fallback: pull every token in this season and ask the launcher
  // which ones the just-emitted setFinalists call marked as finalist. This is
  // robust to multisig / timelock / relay callers because it consults contract
  // storage directly rather than reverse-engineering the tx envelope.
  //
  // Block tag: pin to `event.block.number` so the read sees the post-tx state.
  // Ponder's PublicClient defaults to `latest` which would be correct in real
  // time but races during reorg replay.
  const seasonTokens = await context.db.sql
    .select()
    .from(token)
    .where(eq(token.seasonId, seasonId));
  for (const t of seasonTokens) {
    try {
      const entry = await context.client.readContract({
        abi: context.contracts.FilterLauncher.abi,
        address: context.contracts.FilterLauncher.address,
        functionName: "entryOf",
        args: [seasonId, t.id],
        blockNumber: event.block.number,
      });
      // `entryOf` returns a `TokenEntry` struct; viem decodes to an object whose
      // shape mirrors the ABI's named outputs. Solidity struct keys: `slotIndex`,
      // `feeSplitter`, `isFinalist`. Defensive narrowing for the field we care about.
      const isFinalist =
        typeof entry === "object" && entry !== null && "isFinalist" in entry
          ? Boolean((entry as {isFinalist: unknown}).isFinalist)
          : false;
      if (isFinalist && !t.isFinalist) {
        await context.db.update(token, {id: t.id}).set({isFinalist: true});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[indexer] FinalistsSet chain-read fallback failed for token=${t.id} season=${seasonId}: ${msg}`,
      );
    }
  }
});

/// Epic 1.15a — flips when the launcher activates a season (≥ ACTIVATION_THRESHOLD
/// reservations filled). The Arena UI uses this to switch the slot grid from
/// "PENDING" → "LIVE" badges and to hide the "claim refund" CTAs.
ponder.on("FilterLauncher:SeasonActivated", async ({event, context}) => {
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  // Audit: bugbot M PR #92. The defensive path MUST fall through to the broadcast —
  // this is the only handler that emits `SEASON_ACTIVATED` on the launch SSE stream;
  // a silent skip leaves connected Arena UI clients stuck on the pre-activation grid
  // even after the on-chain state moved. Mirror the `SlotReserved` invariant.
  let filledSlots: bigint;
  if (!summary) {
    // Defensive: SeasonStarted should have inserted the row. If it didn't, create
    // one and stamp activated state — preferable to crashing the indexer.
    await context.db.insert(launchEscrowSummary).values({
      id: event.args.seasonId,
      activated: true,
      activatedAt: event.block.timestamp,
    });
    filledSlots = 0n; // No counter to read on the defensive path; UI re-fetches /launch-status anyway
  } else {
    await context.db
      .update(launchEscrowSummary, {id: event.args.seasonId})
      .set({activated: true, activatedAt: event.block.timestamp});
    filledSlots = BigInt(summary.reservationCount);
  }
  broadcastSeasonStateEvent({
    type: "SEASON_ACTIVATED",
    seasonId: event.args.seasonId,
    filledSlots,
  });
});

/// Epic 1.15a — abort path. The launcher fires `FilterLauncher:SeasonAborted` BEFORE
/// `LaunchEscrow:SeasonAborted`. Both update the same summary row but track different
/// concerns: the launcher signal flips `aborted=true` (UI eligibility for the abort
/// banner); the escrow signal increments `totalRefunded` (per-creator amounts come
/// from `ReservationRefunded` / `RefundFailed` log per creator).
ponder.on("FilterLauncher:SeasonAborted", async ({event, context}) => {
  const seasonId = event.args.seasonId;
  const summary = await context.db.find(launchEscrowSummary, {id: seasonId});
  if (!summary) {
    await context.db.insert(launchEscrowSummary).values({
      id: seasonId,
      aborted: true,
      abortedAt: event.block.timestamp,
    });
  } else {
    await context.db
      .update(launchEscrowSummary, {id: seasonId})
      .set({aborted: true, abortedAt: event.block.timestamp});
  }

  // Audit: bugbot L PR #92. Clear `seasonTickerReservation` rows for this season
  // — the on-chain `seasonTickers[seasonId][hash]` mapping was zeroed by the
  // contract's abort path, so the indexer mirror MUST follow. Without this,
  // `/season/:id/tickers/check` returns `season_taken` for tickers whose
  // contract storage is empty, diverging from on-chain state. Bounded at
  // ≤ MAX_LAUNCHES (12) per aborted season.
  const stale = await context.db.sql
    .select()
    .from(seasonTickerReservation)
    .where(eq(seasonTickerReservation.seasonId, seasonId));
  for (const row of stale) {
    await context.db.delete(seasonTickerReservation, {id: row.id});
  }
});

/// Epic 1.15a — multisig added a ticker hash to the protocol blocklist.
/// CRITICAL: the contract stores the raw `bytes32` (no normalisation), so the operator
/// MUST pass `keccak256(bytes(TickerLib.normalize(s)))`. The TS port of `normalize`
/// in this same package (`src/api/ticker.ts`) reproduces the canonical form for
/// the launch-form pre-flight check.
ponder.on("FilterLauncher:TickerBlocked", async ({event, context}) => {
  await context.db
    .insert(tickerBlocklist)
    .values({id: event.args.tickerHash, blockedAt: event.block.timestamp});

  // Epic 1.21 / spec §47.4 — derive an `operatorActionLog` row. The launcher is
  // byte-budget-excluded from emitting `OperatorActionEmitted` directly (see the
  // natspec on `addTickerToBlocklist`), so the indexer reconstructs the audit row
  // from the existing `TickerBlocked` event + the tx `from` address (the multisig
  // caller).
  //
  // Bugbot PR #95 round 4 (Medium): `params` MUST be ABI-encoded to match the
  // shape of `OperatorActionEmitted`-sourced rows (which carry the raw
  // `event.args.params` blob from `abi.encode(...)`). Pre-fix this stored
  // a bare 32-byte tickerHash, which broke the operator console's
  // ABI decoder (it assumes every row's `params` is decodable per the
  // `action`'s parameter type). `encodeAbiParameters([{type: "bytes32"}], [hash])`
  // produces a 32-byte head that decodes back to `bytes32` cleanly, so the
  // audit-log card can `decodeAbiParameters([{type: "bytes32"}], row.params)`
  // for every action uniformly.
  const encodedParams = encodeAbiParameters(
    [{type: "bytes32"}],
    [event.args.tickerHash],
  );
  // Bugbot PR #95 round 10 (Medium): see CreatorFeeDistributor.ts —
  // `actor` MUST be lowercased at write time so the `/operator/actions?actor=`
  // query (which lowercases its input) matches stored rows.
  await context.db.insert(operatorActionLog).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    actor: event.transaction.from.toLowerCase() as `0x${string}`,
    action: "addTickerToBlocklist",
    params: encodedParams,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});

/// Epic 1.15a — winner ticker is reserved cross-season. Once a ticker wins a season,
/// no future season can re-reserve it. Drives the launch-form pre-flight check:
/// `/season/:id/tickers/check?ticker=PEPE` returns `winner_taken` if a row exists.
ponder.on("FilterLauncher:WinnerTickerReserved", async ({event, context}) => {
  await context.db
    .insert(winnerTickerReservation)
    .values({
      id: event.args.tickerHash,
      seasonId: event.args.seasonId,
      winnerToken: event.args.winnerToken,
      reservedAt: event.block.timestamp,
    });
});
