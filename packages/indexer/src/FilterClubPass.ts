/// FilterClubPass event handlers — Epic 2.6 / spec §47.3.8.
///
/// Tracks the Filter Club lifetime pass through mint, transfer, and the
/// free-launch credit lifecycle:
///
///   Transfer (from == 0x0) — mint; creates the `clubPass` row (credits start
///                            at CREDITS_PER_TOKEN = 2, keyed to the token)
///   Minted                 — same tx, higher log index than the mint Transfer;
///                            stamps `pricePaid` and rolls the `clubStats`
///                            proceeds accounting (audit-budget allocation on
///                            the operator card)
///   Transfer (regular)     — current-owner tracking; credits travel with the
///                            token so nothing else moves
///   CreditConsumed         — a `reserve(msg.value = 0)` redeemed a credit; the
///                            SAME tx emits `LaunchEscrow.SlotReserved` at a
///                            HIGHER log index, whose handler joins this row
///                            via the shared `${seasonId}:${creator}` key to
///                            set `reservation.creditFunded`
///   CreditReclaimed        — trustless credit restore after `abortSeason`
///
/// All hex columns are lowercased at write time (audit: bugbot H PR #92 — the
/// API's query paths normalize via `.toLowerCase()`, and mixed-case TEXT
/// columns never match).

import {ponder} from "@/generated";

import {clubCreditRedemption, clubPass, clubStats} from "../ponder.schema";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const CLUB_STATS_ID = "club";
/// Mirrors `FilterClubPass.CREDITS_PER_TOKEN`. A constant here (not a contract
/// read) — the value is immutable on-chain and a handler-time RPC read would
/// stall historical sync.
const CREDITS_PER_TOKEN = 2;

async function bumpStats(
  context: any,
  delta: {minted?: number; proceedsWei?: bigint; creditsConsumed?: number; creditsReclaimed?: number},
) {
  const existing = await context.db.find(clubStats, {id: CLUB_STATS_ID});
  if (!existing) {
    await context.db.insert(clubStats).values({
      id: CLUB_STATS_ID,
      minted: delta.minted ?? 0,
      proceedsWei: delta.proceedsWei ?? 0n,
      creditsConsumed: delta.creditsConsumed ?? 0,
      creditsReclaimed: delta.creditsReclaimed ?? 0,
    });
    return;
  }
  await context.db.update(clubStats, {id: CLUB_STATS_ID}).set({
    minted: existing.minted + (delta.minted ?? 0),
    proceedsWei: existing.proceedsWei + (delta.proceedsWei ?? 0n),
    creditsConsumed: existing.creditsConsumed + (delta.creditsConsumed ?? 0),
    creditsReclaimed: existing.creditsReclaimed + (delta.creditsReclaimed ?? 0),
  });
}

ponder.on("FilterClubPass:Transfer", async ({event, context}) => {
  const to = event.args.to.toLowerCase() as `0x${string}`;
  const from = event.args.from.toLowerCase() as `0x${string}`;
  const tokenId = event.args.tokenId;

  if (from === ZERO_ADDR) {
    // Mint path. The paired `Minted` event (same tx, higher log index) stamps
    // pricePaid + proceeds; insert with 0 here so the row exists first.
    await context.db.insert(clubPass).values({
      id: tokenId,
      owner: to,
      minter: to,
      mintedAt: event.block.timestamp,
      pricePaid: 0n,
      creditsRemaining: CREDITS_PER_TOKEN,
      lastTransferAt: event.block.timestamp,
    });
    return;
  }

  // Regular transfer — credits are keyed to the token, so only ownership moves.
  await context.db.update(clubPass, {id: tokenId}).set({
    owner: to,
    lastTransferAt: event.block.timestamp,
  });
});

ponder.on("FilterClubPass:Minted", async ({event, context}) => {
  await context.db.update(clubPass, {id: event.args.tokenId}).set({
    pricePaid: event.args.pricePaid,
  });
  await bumpStats(context, {minted: 1, proceedsWei: event.args.pricePaid});
});

ponder.on("FilterClubPass:CreditConsumed", async ({event, context}) => {
  const holder = event.args.holder.toLowerCase() as `0x${string}`;
  const tokenId = event.args.tokenId;
  const seasonId = event.args.seasonId;

  await context.db.insert(clubCreditRedemption).values({
    id: `${seasonId.toString()}:${holder}`,
    seasonId,
    creator: holder,
    tokenId,
    status: "CONSUMED",
    consumedAt: event.block.timestamp,
  });

  const pass = await context.db.find(clubPass, {id: tokenId});
  if (pass) {
    await context.db.update(clubPass, {id: tokenId}).set({
      creditsRemaining: Math.max(0, pass.creditsRemaining - 1),
    });
  }
  await bumpStats(context, {creditsConsumed: 1});
});

ponder.on("FilterClubPass:CreditReclaimed", async ({event, context}) => {
  const creator = event.args.creator.toLowerCase() as `0x${string}`;
  const tokenId = event.args.tokenId;
  const seasonId = event.args.seasonId;

  await context.db.update(clubCreditRedemption, {id: `${seasonId.toString()}:${creator}`}).set({
    status: "RECLAIMED",
    reclaimedAt: event.block.timestamp,
  });

  const pass = await context.db.find(clubPass, {id: tokenId});
  if (pass) {
    await context.db.update(clubPass, {id: tokenId}).set({
      // The credit returns to the TOKEN (current owner benefits — consistent
      // with credits travelling on transfer). Clamp to the on-chain ceiling
      // defensively; conservation on-chain makes overflow unreachable.
      creditsRemaining: Math.min(CREDITS_PER_TOKEN, pass.creditsRemaining + 1),
    });
  }
  await bumpStats(context, {creditsReclaimed: 1});
});
