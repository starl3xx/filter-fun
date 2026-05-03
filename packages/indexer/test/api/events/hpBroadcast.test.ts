/// Tests for the HP_UPDATED broadcast bridge — Epic 1.17b.
///
/// Verifies that production handlers, which pass `broadcastHpUpdated` to
/// `recomputeAndStampHp` as the `onWritten` hook, fan HP_UPDATED frames
/// out through the same Hub instance the SSE route subscribes to. Without
/// this wiring, the headline "≤5s end-to-end refresh" feature in the
/// compute-pathway design produces no SSE traffic.

import {beforeEach, describe, expect, it} from "vitest";

import {
  broadcastHpUpdated,
  setHpBroadcastHub,
  setHpBroadcastNextId,
} from "../../../src/api/events/hpBroadcast.js";
import {Hub} from "../../../src/api/events/hub.js";
import type {HpRecomputeWriteResult} from "../../../src/api/hpRecomputeWriter.js";
import {HP_WEIGHTS_VERSION, type ScoredToken} from "@filter-fun/scoring";

const TOKEN_A = "0x000000000000000000000000000000000000000a" as `0x${string}`;
const TOKEN_B = "0x000000000000000000000000000000000000000b" as `0x${string}`;

function fakeScoredToken(over: Partial<ScoredToken> = {}): ScoredToken {
  return {
    token: TOKEN_A,
    rank: 1,
    hp: 0.87,
    phase: "preFilter",
    baseComposite: 0.85,
    weightsVersion: HP_WEIGHTS_VERSION,
    flagsActive: {momentum: false, concentration: true},
    components: {
      velocity: {score: 0.9, weight: 0.30, label: "Buying activity"},
      effectiveBuyers: {score: 0.7, weight: 0.15, label: "Real participants"},
      stickyLiquidity: {score: 0.8, weight: 0.30, label: "Liquidity strength"},
      retention: {score: 1.0, weight: 0.15, label: "Holder conviction"},
      momentum: {score: 0, weight: 0, label: "Momentum"},
      holderConcentration: {score: 0.4, weight: 0.10, label: "Holder distribution"},
    },
    ...over,
  };
}

describe("broadcastHpUpdated", () => {
  let hub: Hub;
  let nextId: number;

  beforeEach(() => {
    hub = new Hub({perConnQueueMax: 100});
    nextId = 1;
    setHpBroadcastHub(hub);
    setHpBroadcastNextId(() => nextId++);
  });

  it("emits one HP_UPDATED frame per write, observable on a hub subscriber", async () => {
    const sub = hub.connect();
    const writes: HpRecomputeWriteResult[] = [
      {
        token: TOKEN_A,
        rank: 1,
        hp: 87,
        trigger: "SWAP",
        scored: fakeScoredToken({token: TOKEN_A, rank: 1}),
        blockTimestamp: 1_700_000_000n,
      },
    ];
    const tickerByAddress = new Map<string, string>([[TOKEN_A.toLowerCase(), "$EDGE"]]);

    broadcastHpUpdated(writes, tickerByAddress);

    const ev = await sub.next(50);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("HP_UPDATED");
    expect(ev!.priority).toBe("LOW");
    expect(ev!.message).toBe("");
    expect(ev!.address).toBe(TOKEN_A);
    expect(ev!.token).toBe("$EDGE");
    sub.close();
  });

  it("uses the injected nextId source so frames advance monotonically", async () => {
    const sub = hub.connect();
    const writeA: HpRecomputeWriteResult = {
      token: TOKEN_A,
      rank: 1,
      hp: 87,
      trigger: "SWAP",
      scored: fakeScoredToken({token: TOKEN_A, rank: 1}),
      blockTimestamp: 1_700_000_000n,
    };
    const writeB: HpRecomputeWriteResult = {
      token: TOKEN_B,
      rank: 2,
      hp: 55,
      trigger: "BLOCK_TICK",
      scored: fakeScoredToken({token: TOKEN_B, rank: 2, hp: 0.55}),
      blockTimestamp: 1_700_000_001n,
    };
    const tickerByAddress = new Map<string, string>([
      [TOKEN_A.toLowerCase(), "$A"],
      [TOKEN_B.toLowerCase(), "$B"],
    ]);

    broadcastHpUpdated([writeA, writeB], tickerByAddress);

    const ev1 = await sub.next(50);
    const ev2 = await sub.next(50);
    expect(ev1!.id).toBe(1);
    expect(ev2!.id).toBe(2);
    sub.close();
  });

  it("emits no frames for an empty writes array", async () => {
    const sub = hub.connect();
    broadcastHpUpdated([], new Map());
    const ev = await sub.next(20);
    expect(ev).toBeNull();
    sub.close();
  });

  it("falls back to a no-op when the hub is unset (handler liveness preserved)", () => {
    setHpBroadcastHub(null as unknown as Hub);
    const writes: HpRecomputeWriteResult[] = [
      {
        token: TOKEN_A,
        rank: 1,
        hp: 87,
        trigger: "SWAP",
        scored: fakeScoredToken(),
        blockTimestamp: 1_700_000_000n,
      },
    ];
    expect(() =>
      broadcastHpUpdated(writes, new Map([[TOKEN_A.toLowerCase(), "$X"]])),
    ).not.toThrow();
  });

  it("missing ticker entry falls through with empty token field (clients can join via address)", async () => {
    const sub = hub.connect();
    const writes: HpRecomputeWriteResult[] = [
      {
        token: TOKEN_A,
        rank: 1,
        hp: 87,
        trigger: "SWAP",
        scored: fakeScoredToken(),
        blockTimestamp: 1_700_000_000n,
      },
    ];

    broadcastHpUpdated(writes, new Map()); // empty ticker map

    const ev = await sub.next(50);
    expect(ev).not.toBeNull();
    expect(ev!.token).toBe("");
    expect(ev!.address).toBe(TOKEN_A);
    sub.close();
  });
});
