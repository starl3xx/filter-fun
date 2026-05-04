/// Tests for the reservation-lifecycle SSE broadcast bridge — Epic 1.15a.
///
/// `launchBroadcast.ts` translates Ponder handler payloads into wire-format
/// `TickerEvent` frames on a dedicated `launchHub`. Verify each event type
/// produces the right priority, the data envelope contains the seasonId
/// (used by /season/:id/launch/stream as the per-stream filter), and the
/// id counter advances monotonically.

import {describe, expect, it} from "vitest";

import {
  broadcastReservationEvent,
  broadcastSeasonStateEvent,
  getLaunchHub,
} from "../../../src/api/events/launchBroadcast.js";

const CREATOR_A = "0x000000000000000000000000000000000000aaaa" as `0x${string}`;
const CREATOR_B = "0x000000000000000000000000000000000000bbbb" as `0x${string}`;
const TOKEN_X = "0x000000000000000000000000000000000000c0de" as `0x${string}`;
const TICKER_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

describe("broadcastReservationEvent", () => {
  it("emits SLOT_RESERVED at LOW priority with seasonId in the envelope", async () => {
    const sub = getLaunchHub().connect();
    broadcastReservationEvent({
      type: "SLOT_RESERVED",
      seasonId: 7n,
      creator: CREATOR_A,
      amountWei: 50_000_000_000_000_000n,
      slotIndex: 2n,
      tickerHash: TICKER_HASH,
    });
    const ev = await sub.next(50);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("SLOT_RESERVED");
    expect(ev!.priority).toBe("LOW");
    expect(ev!.data.seasonId).toBe("7");
    expect(ev!.data.creator).toBe(CREATOR_A);
    expect(ev!.data.amountWei).toBe("50000000000000000");
    expect(ev!.data.slotIndex).toBe("2");
    expect(ev!.data.tickerHash).toBe(TICKER_HASH);
    expect(ev!.address).toBeNull();
    sub.close();
  });

  it("SLOT_REFUND_PENDING uses HIGH priority — surfaces refund-required signal", async () => {
    const sub = getLaunchHub().connect();
    broadcastReservationEvent({
      type: "SLOT_REFUND_PENDING",
      seasonId: 3n,
      creator: CREATOR_B,
      amountWei: 100_000_000_000_000_000n,
    });
    const ev = await sub.next(50);
    expect(ev!.priority).toBe("HIGH");
    expect(ev!.data.seasonId).toBe("3");
    expect(ev!.message).toMatch(/claim/i);
    sub.close();
  });

  it("SLOT_FORFEITED carries the token address on the envelope", async () => {
    const sub = getLaunchHub().connect();
    broadcastReservationEvent({
      type: "SLOT_FORFEITED",
      seasonId: 5n,
      creator: CREATOR_A,
      amountWei: 50_000_000_000_000_000n,
      token: TOKEN_X,
    });
    const ev = await sub.next(50);
    expect(ev!.priority).toBe("MEDIUM");
    expect(ev!.address).toBe(TOKEN_X);
    expect(ev!.data.token).toBe(TOKEN_X);
    sub.close();
  });

  it("monotonic id across reservation and season-state events", async () => {
    const sub = getLaunchHub().connect();
    broadcastReservationEvent({
      type: "SLOT_RESERVED",
      seasonId: 9n,
      creator: CREATOR_A,
    });
    broadcastSeasonStateEvent({
      type: "SEASON_ACTIVATED",
      seasonId: 9n,
      filledSlots: 4n,
    });
    const ev1 = await sub.next(50);
    const ev2 = await sub.next(50);
    expect(ev1!.id).toBeLessThan(ev2!.id);
    sub.close();
  });
});

describe("broadcastSeasonStateEvent", () => {
  it("SEASON_ACTIVATED is HIGH priority", async () => {
    const sub = getLaunchHub().connect();
    broadcastSeasonStateEvent({
      type: "SEASON_ACTIVATED",
      seasonId: 11n,
      filledSlots: 6n,
    });
    const ev = await sub.next(50);
    expect(ev!.type).toBe("SEASON_ACTIVATED");
    expect(ev!.priority).toBe("HIGH");
    expect(ev!.data.seasonId).toBe("11");
    expect(ev!.data.filledSlots).toBe("6");
    sub.close();
  });

  it("SEASON_ABORTED carries reservationCount + totalRefunded", async () => {
    const sub = getLaunchHub().connect();
    broadcastSeasonStateEvent({
      type: "SEASON_ABORTED",
      seasonId: 12n,
      reservationCount: 3n,
      totalRefundedWei: 150_000_000_000_000_000n,
    });
    const ev = await sub.next(50);
    expect(ev!.type).toBe("SEASON_ABORTED");
    expect(ev!.priority).toBe("HIGH");
    expect(ev!.data.reservationCount).toBe("3");
    expect(ev!.data.totalRefundedWei).toBe("150000000000000000");
    sub.close();
  });
});

describe("getLaunchHub", () => {
  it("returns the singleton — multiple subscribers see the same broadcast", async () => {
    const subA = getLaunchHub().connect();
    const subB = getLaunchHub().connect();
    broadcastReservationEvent({
      type: "SLOT_RESERVED",
      seasonId: 42n,
      creator: CREATOR_A,
    });
    const evA = await subA.next(50);
    const evB = await subB.next(50);
    expect(evA!.data.seasonId).toBe("42");
    expect(evB!.data.seasonId).toBe("42");
    subA.close();
    subB.close();
  });
});
