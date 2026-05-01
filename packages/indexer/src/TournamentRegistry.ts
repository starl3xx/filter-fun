import {ponder} from "@/generated";

import {
  tournamentAnnualEntrant,
  tournamentQuarterEntrant,
  tournamentStatus,
} from "../ponder.schema";

/// Mirrors `TournamentRegistry` events into the indexer schema so /profile can derive
/// `createdTokens[].status` and `badges` (QUARTERLY_FINALIST/CHAMPION + ANNUAL_*) without
/// a per-request RPC roundtrip into the registry contract.
///
/// Status is **monotonic in the "best title earned" direction** per the contract:
/// ACTIVE < FILTERED (terminal) and ACTIVE < WEEKLY_WINNER < QUARTERLY_FINALIST <
/// QUARTERLY_CHAMPION < ANNUAL_FINALIST < ANNUAL_CHAMPION. We always overwrite to the
/// new status — the contract ensures we never see a regression.
///
/// `tournamentQuarterEntrant` / `tournamentAnnualEntrant` are append-only membership
/// facts: once a token competed in (year, quarter) it's a finalist for that period
/// forever. `isChampion` flips when the corresponding champion event fires.

ponder.on("TournamentRegistry:WeeklyWinnerRecorded", async ({event, context}) => {
  const id = event.args.winner;
  const existing = await context.db.find(tournamentStatus, {id});
  const payload = {
    status: "WEEKLY_WINNER",
    year: null,
    quarter: null,
    lastUpdatedAt: event.block.timestamp,
  };
  if (existing) {
    await context.db.update(tournamentStatus, {id}).set(payload);
  } else {
    await context.db.insert(tournamentStatus).values({id, ...payload});
  }
});

ponder.on("TournamentRegistry:TokenFiltered", async ({event, context}) => {
  const id = event.args.token;
  const existing = await context.db.find(tournamentStatus, {id});
  const payload = {
    status: "FILTERED",
    year: null,
    quarter: null,
    lastUpdatedAt: event.block.timestamp,
  };
  if (existing) {
    await context.db.update(tournamentStatus, {id}).set(payload);
  } else {
    await context.db.insert(tournamentStatus).values({id, ...payload});
  }
});

ponder.on("TournamentRegistry:QuarterlyFinalistsRecorded", async ({event, context}) => {
  const year = Number(event.args.year);
  const quarter = Number(event.args.quarter);
  for (const t of event.args.entrants) {
    await context.db.insert(tournamentQuarterEntrant).values({
      id: `${year}:${quarter}:${t}`.toLowerCase(),
      year,
      quarter,
      token: t,
      isChampion: false,
      recordedAt: event.block.timestamp,
    });
    const existing = await context.db.find(tournamentStatus, {id: t});
    const payload = {
      status: "QUARTERLY_FINALIST",
      year,
      quarter,
      lastUpdatedAt: event.block.timestamp,
    };
    if (existing) {
      await context.db.update(tournamentStatus, {id: t}).set(payload);
    } else {
      await context.db.insert(tournamentStatus).values({id: t, ...payload});
    }
  }
});

ponder.on("TournamentRegistry:QuarterlyChampionRecorded", async ({event, context}) => {
  const year = Number(event.args.year);
  const quarter = Number(event.args.quarter);
  const champion = event.args.champion;
  const entrantId = `${year}:${quarter}:${champion}`.toLowerCase();
  const existingEntrant = await context.db.find(tournamentQuarterEntrant, {id: entrantId});
  if (existingEntrant) {
    await context.db.update(tournamentQuarterEntrant, {id: entrantId}).set({isChampion: true});
  } else {
    // Defensive: contract auth requires the champion to be a registered finalist, so
    // we should always have a row. If we don't (replay glitch), insert one so badge
    // derivation still works.
    await context.db.insert(tournamentQuarterEntrant).values({
      id: entrantId,
      year,
      quarter,
      token: champion,
      isChampion: true,
      recordedAt: event.block.timestamp,
    });
  }
  const existingStatus = await context.db.find(tournamentStatus, {id: champion});
  const payload = {
    status: "QUARTERLY_CHAMPION",
    year,
    quarter,
    lastUpdatedAt: event.block.timestamp,
  };
  if (existingStatus) {
    await context.db.update(tournamentStatus, {id: champion}).set(payload);
  } else {
    await context.db.insert(tournamentStatus).values({id: champion, ...payload});
  }
});

ponder.on("TournamentRegistry:AnnualFinalistsRecorded", async ({event, context}) => {
  const year = Number(event.args.year);
  for (const t of event.args.entrants) {
    await context.db.insert(tournamentAnnualEntrant).values({
      id: `${year}:${t}`.toLowerCase(),
      year,
      token: t,
      isChampion: false,
      recordedAt: event.block.timestamp,
    });
    const existing = await context.db.find(tournamentStatus, {id: t});
    const payload = {
      status: "ANNUAL_FINALIST",
      year,
      quarter: null,
      lastUpdatedAt: event.block.timestamp,
    };
    if (existing) {
      await context.db.update(tournamentStatus, {id: t}).set(payload);
    } else {
      await context.db.insert(tournamentStatus).values({id: t, ...payload});
    }
  }
});

ponder.on("TournamentRegistry:AnnualChampionRecorded", async ({event, context}) => {
  const year = Number(event.args.year);
  const champion = event.args.champion;
  const entrantId = `${year}:${champion}`.toLowerCase();
  const existingEntrant = await context.db.find(tournamentAnnualEntrant, {id: entrantId});
  if (existingEntrant) {
    await context.db.update(tournamentAnnualEntrant, {id: entrantId}).set({isChampion: true});
  } else {
    await context.db.insert(tournamentAnnualEntrant).values({
      id: entrantId,
      year,
      token: champion,
      isChampion: true,
      recordedAt: event.block.timestamp,
    });
  }
  const existingStatus = await context.db.find(tournamentStatus, {id: champion});
  const payload = {
    status: "ANNUAL_CHAMPION",
    year,
    quarter: null,
    lastUpdatedAt: event.block.timestamp,
  };
  if (existingStatus) {
    await context.db.update(tournamentStatus, {id: champion}).set(payload);
  } else {
    await context.db.insert(tournamentStatus).values({id: champion, ...payload});
  }
});
