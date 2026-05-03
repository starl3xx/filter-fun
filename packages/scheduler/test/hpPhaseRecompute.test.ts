/// Tests for the phase-boundary HP recompute scheduler — Epic 1.17b.
///
/// Pure-function coverage: boundary table, tolerance window, idempotency
/// state, webhook dispatch via injected callable. No live HTTP needed.

import {describe, expect, it} from "vitest";

import {
  BOUNDARY_TOLERANCE_SEC,
  boundaryForTick,
  makeEmptyState,
  phaseBoundaries,
  runPhaseTick,
  type HpPhaseTrigger,
  type PhaseRecomputeWebhook,
} from "../src/hpPhaseRecompute.js";

const STARTED = 1_700_000_000n;
const HOUR = 3600n;

describe("phaseBoundaries", () => {
  it("returns the six locked boundaries in ascending order", () => {
    const bs = phaseBoundaries(STARTED);
    expect(bs.map((b) => b.hour)).toEqual([0, 24, 48, 72, 96, 168]);
    for (let i = 1; i < bs.length; i++) {
      expect(bs[i]!.atSec).toBeGreaterThan(bs[i - 1]!.atSec);
    }
  });

  it("h0/24/48/72 → PHASE_BOUNDARY, h96 → CUT, h168 → FINALIZE", () => {
    const bs = phaseBoundaries(STARTED);
    expect(bs[0]!.trigger).toBe<HpPhaseTrigger>("PHASE_BOUNDARY");
    expect(bs[1]!.trigger).toBe<HpPhaseTrigger>("PHASE_BOUNDARY");
    expect(bs[2]!.trigger).toBe<HpPhaseTrigger>("PHASE_BOUNDARY");
    expect(bs[3]!.trigger).toBe<HpPhaseTrigger>("PHASE_BOUNDARY");
    expect(bs[4]!.trigger).toBe<HpPhaseTrigger>("CUT");
    expect(bs[5]!.trigger).toBe<HpPhaseTrigger>("FINALIZE");
  });

  it("atSec values are startedAt + hour*3600", () => {
    const bs = phaseBoundaries(STARTED);
    expect(bs[0]!.atSec).toBe(STARTED);
    expect(bs[4]!.atSec).toBe(STARTED + 96n * HOUR);
    expect(bs[5]!.atSec).toBe(STARTED + 168n * HOUR);
  });
});

describe("boundaryForTick — tolerance window", () => {
  it("matches a tick exactly at a boundary", () => {
    expect(boundaryForTick(STARTED, STARTED + 96n * HOUR)?.hour).toBe(96);
  });

  it("matches within ±10s tolerance", () => {
    expect(boundaryForTick(STARTED, STARTED + 96n * HOUR + 5n)?.hour).toBe(96);
    expect(boundaryForTick(STARTED, STARTED + 96n * HOUR - 5n)?.hour).toBe(96);
  });

  it("returns null outside tolerance", () => {
    expect(boundaryForTick(STARTED, STARTED + 96n * HOUR + BOUNDARY_TOLERANCE_SEC + 1n))
      .toBeNull();
    expect(boundaryForTick(STARTED, STARTED + 1n * HOUR)).toBeNull();
  });

  it("disambiguates: at hour 0 returns the h0 boundary, not later", () => {
    const b = boundaryForTick(STARTED, STARTED);
    expect(b?.hour).toBe(0);
    expect(b?.trigger).toBe<HpPhaseTrigger>("PHASE_BOUNDARY");
  });
});

describe("runPhaseTick", () => {
  function fakeWebhook(): {
    fn: PhaseRecomputeWebhook;
    calls: Array<{seasonId: bigint; trigger: HpPhaseTrigger; hour: number}>;
    nextResult: boolean;
  } {
    const calls: Array<{seasonId: bigint; trigger: HpPhaseTrigger; hour: number}> = [];
    const ctx = {nextResult: true};
    return {
      fn: async (seasonId, trigger, hour) => {
        calls.push({seasonId, trigger, hour});
        return ctx.nextResult;
      },
      calls,
      get nextResult() {return ctx.nextResult;},
      set nextResult(v: boolean) {ctx.nextResult = v;},
    } as ReturnType<typeof fakeWebhook>;
  }

  it("fires the webhook within tolerance and marks the boundary fired", async () => {
    const state = makeEmptyState();
    const wh = fakeWebhook();
    const r = await runPhaseTick(
      state,
      {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + 96n * HOUR},
      wh.fn,
    );
    expect(r.fired?.boundary.hour).toBe(96);
    expect(r.fired?.boundary.trigger).toBe<HpPhaseTrigger>("CUT");
    expect(r.fired?.webhookOk).toBe(true);
    expect(wh.calls).toHaveLength(1);
    expect(state.firedFor.has("1:96")).toBe(true);
  });

  it("a second tick within the same boundary window is a no-op (idempotent)", async () => {
    const state = makeEmptyState();
    const wh = fakeWebhook();
    await runPhaseTick(
      state,
      {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + 96n * HOUR},
      wh.fn,
    );
    const r2 = await runPhaseTick(
      state,
      {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + 96n * HOUR + 3n},
      wh.fn,
    );
    expect(r2.fired).toBeNull();
    expect(wh.calls).toHaveLength(1);
  });

  it("a different season fires independently for the same hour", async () => {
    const state = makeEmptyState();
    const wh = fakeWebhook();
    await runPhaseTick(
      state,
      {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + 96n * HOUR},
      wh.fn,
    );
    await runPhaseTick(
      state,
      {seasonId: 2n, seasonStartedAtSec: STARTED, nowSec: STARTED + 96n * HOUR},
      wh.fn,
    );
    expect(wh.calls.map((c) => c.seasonId)).toEqual([1n, 2n]);
  });

  it("a webhook failure does NOT mark the boundary fired (caller can retry)", async () => {
    const state = makeEmptyState();
    const wh = fakeWebhook();
    wh.nextResult = false;
    const r = await runPhaseTick(
      state,
      {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + 96n * HOUR},
      wh.fn,
    );
    expect(r.fired?.webhookOk).toBe(false);
    expect(state.firedFor.has("1:96")).toBe(false);
    // Next tick (still in tolerance) retries.
    wh.nextResult = true;
    const r2 = await runPhaseTick(
      state,
      {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + 96n * HOUR + 3n},
      wh.fn,
    );
    expect(r2.fired?.webhookOk).toBe(true);
    expect(state.firedFor.has("1:96")).toBe(true);
  });

  it("ticks outside any boundary window return fired=null without webhook", async () => {
    const state = makeEmptyState();
    const wh = fakeWebhook();
    const r = await runPhaseTick(
      state,
      {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + 12n * HOUR},
      wh.fn,
    );
    expect(r.fired).toBeNull();
    expect(wh.calls).toHaveLength(0);
  });

  it("end-to-end: drives a full season's six boundaries with one webhook each", async () => {
    const state = makeEmptyState();
    const wh = fakeWebhook();
    for (const hour of [0n, 24n, 48n, 72n, 96n, 168n]) {
      await runPhaseTick(
        state,
        {seasonId: 1n, seasonStartedAtSec: STARTED, nowSec: STARTED + hour * HOUR},
        wh.fn,
      );
    }
    expect(wh.calls.map((c) => c.hour)).toEqual([0, 24, 48, 72, 96, 168]);
    expect(wh.calls.find((c) => c.hour === 96)!.trigger).toBe<HpPhaseTrigger>("CUT");
    expect(wh.calls.find((c) => c.hour === 168)!.trigger).toBe<HpPhaseTrigger>("FINALIZE");
  });
});
