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
import {decodeFunctionData} from "viem";

import {broadcastSeasonStateEvent} from "./api/events/launchBroadcast.js";
import {
  launchEscrowSummary,
  phaseChange,
  reservation,
  season,
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
  await context.db.insert(token).values({
    id: event.args.token,
    seasonId: event.args.seasonId,
    symbol: event.args.symbol,
    name: event.args.name,
    metadataUri: event.args.metadataURI,
    creator: event.args.creator,
    locker: event.args.locker,
    isProtocolLaunched: event.args.isProtocolLaunched,
    createdAt: event.block.timestamp,
  });

  // Reservation lifecycle: mark the matching `(seasonId, creator)` reservation
  // RELEASED and pin the launched token address. Protocol-token launches DON'T
  // have a matching reservation (FILTER bypasses the escrow), so the upsert
  // is conditional on whether a row exists — `update` would fail silently
  // otherwise. We use `find` first to avoid the upsert path for protocol launches.
  const reservationId = `${event.args.seasonId.toString()}:${event.args.creator.toLowerCase()}`;
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
  // The lean event carries only `seasonId` — the finalist list lives in the
  // transaction calldata. `decodeFunctionData` returns a tuple matching the
  // ABI's input order: `[seasonId, finalists]`. A non-`setFinalists` selector
  // shouldn't be possible (the event only fires inside that function), but
  // wrap in try/catch so a future contract refactor that adds a different
  // emitter doesn't crash the indexer.
  try {
    const decoded = decodeFunctionData({
      abi: FilterLauncherAbi,
      data: event.transaction.input,
    });
    if (decoded.functionName !== "setFinalists") return;
    const [, finalists] = decoded.args as [bigint, readonly `0x${string}`[]];
    for (const finalistAddr of finalists) {
      const existing = await context.db.find(token, {id: finalistAddr});
      if (!existing) continue; // unknown token — oracle config error; skip
      await context.db
        .update(token, {id: finalistAddr})
        .set({isFinalist: true});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[indexer] FilterLauncher:FinalistsSet decode failed for season=${event.args.seasonId} tx=${event.transaction.hash}: ${msg}`,
    );
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
  const summary = await context.db.find(launchEscrowSummary, {id: event.args.seasonId});
  if (!summary) {
    await context.db.insert(launchEscrowSummary).values({
      id: event.args.seasonId,
      aborted: true,
      abortedAt: event.block.timestamp,
    });
    return;
  }
  await context.db
    .update(launchEscrowSummary, {id: event.args.seasonId})
    .set({aborted: true, abortedAt: event.block.timestamp});
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
