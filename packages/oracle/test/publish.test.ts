import {describe, expect, it} from "vitest";
import type {Address} from "viem";

import {buildBonusPayload} from "../src/bonus.js";
import {buildSettlementPayload} from "../src/settlement.js";
import {splitBonusForPublication, splitSettlementForPublication} from "../src/publish.js";

const VAULT: Address = "0x000000000000000000000000000000000000fafe";
const DIST: Address = "0x000000000000000000000000000000000000b011";
const W: Address = "0x9999999999999999999999999999999999999999";
const L1: Address = "0x1111111111111111111111111111111111111111";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("splitSettlementForPublication", () => {
  it("emits one entry per holder, keyed by lowercase address", () => {
    const payload = buildSettlementPayload({
      ranking: [W, L1],
      recoverable: new Map([[L1, 1_000n]]),
      slippageBps: 0,
      shares: new Map([[ALICE, 60n], [BOB, 40n]]),
      liquidationDeadline: 1_700_000_000n,
    });
    const out = splitSettlementForPublication(payload, VAULT, 7n);

    expect(Object.keys(out).sort()).toEqual([ALICE.toLowerCase(), BOB.toLowerCase()].sort());
    const aliceEntry = out[ALICE.toLowerCase() as Address]!;
    expect(aliceEntry.seasonId).toBe("7");
    expect(aliceEntry.vault).toBe(VAULT);
    expect(aliceEntry.share).toBe("60");
    expect(aliceEntry.proof).toEqual(payload.tree.entries.find((e) => e.user === ALICE)!.proof);
  });

  it("encodes bigints as decimal strings (JSON-safe)", () => {
    const payload = buildSettlementPayload({
      ranking: [W, L1],
      recoverable: new Map([[L1, 1_000n]]),
      slippageBps: 0,
      shares: new Map([[ALICE, 12_345_678_901_234_567_890n]]), // > 2^53
      liquidationDeadline: 1_700_000_000n,
    });
    const out = splitSettlementForPublication(payload, VAULT, 1n);
    const entry = out[ALICE.toLowerCase() as Address]!;
    expect(typeof entry.share).toBe("string");
    expect(BigInt(entry.share)).toBe(12_345_678_901_234_567_890n);
    // Round-trips through JSON.
    expect(JSON.parse(JSON.stringify(entry)).share).toBe("12345678901234567890");
  });
});

describe("splitBonusForPublication", () => {
  it("emits one entry per eligible holder, with amount + distributor", () => {
    const payload = buildBonusPayload({
      snapshots: [new Map([[ALICE, 100n], [BOB, 100n]])],
      rolledByHolder: new Map([[ALICE, 60n], [BOB, 40n]]),
      totalReserve: 1_000n,
    });
    const out = splitBonusForPublication(payload, DIST, 3n);
    expect(Object.keys(out).sort()).toEqual([ALICE.toLowerCase(), BOB.toLowerCase()].sort());

    const aliceEntry = out[ALICE.toLowerCase() as Address]!;
    expect(aliceEntry.seasonId).toBe("3");
    expect(aliceEntry.distributor).toBe(DIST);
    expect(typeof aliceEntry.amount).toBe("string");
    // Pro-rata: 60/(60+40) * 1000 = 600
    expect(BigInt(aliceEntry.amount)).toBe(600n);
    expect(aliceEntry.proof).toEqual(payload.entries.find((e) => e.user === ALICE)!.proof);
  });
});
