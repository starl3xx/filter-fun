import {describe, expect, it} from "vitest";
import type {Address} from "viem";

import {buildBonusPayload} from "../src/bonus.js";
import {bonusLeaf, verifyProof} from "../src/merkle.js";

const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL: Address = "0xcccccccccccccccccccccccccccccccccccccccc";
const DAVE: Address = "0xd000000000000000000000000000000000000000";

describe("buildBonusPayload", () => {
  it("includes holders who held ≥ threshold of rolled across every snapshot", () => {
    // Threshold defaults to 8000 BPS (80%). Alice rolled 100, held ≥80 across both snaps. Eligible.
    const p = buildBonusPayload({
      snapshots: [
        new Map([[ALICE, 90n]]),
        new Map([[ALICE, 80n]]), // min = 80, exactly the threshold
      ],
      rolledByHolder: new Map([[ALICE, 100n]]),
      totalReserve: 1_000n,
    });
    expect(p.entries.map((e) => e.user)).toEqual([ALICE]);
    expect(p.entries[0]!.amount).toBe(1_000n);
  });

  it("excludes holders who dipped below threshold in any snapshot", () => {
    // Bob rolled 100. Min balance is 70 < 80% threshold. Ineligible.
    const p = buildBonusPayload({
      snapshots: [
        new Map([[ALICE, 100n], [BOB, 90n]]),
        new Map([[ALICE, 100n], [BOB, 70n]]), // bob dipped
        new Map([[ALICE, 100n], [BOB, 100n]]),
      ],
      rolledByHolder: new Map([[ALICE, 100n], [BOB, 100n]]),
      totalReserve: 200n,
    });
    expect(p.entries.map((e) => e.user)).toEqual([ALICE]);
    expect(p.entries[0]!.amount).toBe(200n);
  });

  it("allocates pro-rata by rolledAmount among eligible holders", () => {
    // Alice rolled 60, Bob rolled 40, both eligible. Bonus reserve 1000.
    //   Alice: 60/100 * 1000 = 600. Bob: 40/100 * 1000 = 400.
    const p = buildBonusPayload({
      snapshots: [new Map([[ALICE, 60n], [BOB, 40n]])],
      rolledByHolder: new Map([[ALICE, 60n], [BOB, 40n]]),
      totalReserve: 1_000n,
    });
    const byUser = new Map(p.entries.map((e) => [e.user, e.amount]));
    expect(byUser.get(ALICE)).toBe(600n);
    expect(byUser.get(BOB)).toBe(400n);
    expect(p.totalAllocated).toBe(1_000n);
  });

  it("ignores holders with zero rolledAmount", () => {
    // Carol shows up in snapshots but never claimed rollover (rolled = 0). Not eligible.
    const p = buildBonusPayload({
      snapshots: [new Map([[ALICE, 100n], [CAROL, 9_999n]])],
      rolledByHolder: new Map([[ALICE, 100n], [CAROL, 0n]]),
      totalReserve: 100n,
    });
    expect(p.entries.map((e) => e.user)).toEqual([ALICE]);
  });

  it("respects a custom holdThresholdBps", () => {
    // Threshold = 50%. Alice held 50% of rolled. Eligible at 5000 bps, ineligible at 8000.
    const loose = buildBonusPayload({
      snapshots: [new Map([[ALICE, 50n]])],
      rolledByHolder: new Map([[ALICE, 100n]]),
      totalReserve: 100n,
      holdThresholdBps: 5000,
    });
    expect(loose.entries.map((e) => e.user)).toEqual([ALICE]);

    expect(() =>
      buildBonusPayload({
        snapshots: [new Map([[ALICE, 50n]])],
        rolledByHolder: new Map([[ALICE, 100n]]),
        totalReserve: 100n,
        holdThresholdBps: 8000,
      }),
    ).toThrow(/no eligible holders/);
  });

  it("emits proofs that verify against the published root", () => {
    const p = buildBonusPayload({
      snapshots: [new Map([[ALICE, 100n], [BOB, 100n], [CAROL, 100n]])],
      rolledByHolder: new Map([[ALICE, 100n], [BOB, 100n], [CAROL, 100n]]),
      totalReserve: 300n,
    });
    expect(p.entries.length).toBe(3);
    for (const e of p.entries) {
      const leaf = bonusLeaf(e.user, e.amount);
      expect(verifyProof(leaf, e.proof, p.root)).toBe(true);
    }
  });

  it("is deterministic regardless of map insertion order", () => {
    const a = buildBonusPayload({
      snapshots: [new Map([[ALICE, 100n], [BOB, 100n]])],
      rolledByHolder: new Map([[ALICE, 60n], [BOB, 40n]]),
      totalReserve: 100n,
    });
    const b = buildBonusPayload({
      snapshots: [new Map([[BOB, 100n], [ALICE, 100n]])],
      rolledByHolder: new Map([[BOB, 40n], [ALICE, 60n]]),
      totalReserve: 100n,
    });
    expect(a.root).toBe(b.root);
  });

  it("rejects empty snapshots", () => {
    expect(() =>
      buildBonusPayload({
        snapshots: [],
        rolledByHolder: new Map([[ALICE, 100n]]),
        totalReserve: 100n,
      }),
    ).toThrow(/snapshots must be non-empty/);
  });

  it("rejects zero or negative totalReserve", () => {
    expect(() =>
      buildBonusPayload({
        snapshots: [new Map()],
        rolledByHolder: new Map([[ALICE, 100n]]),
        totalReserve: 0n,
      }),
    ).toThrow(/totalReserve/);
  });

  it("rejects when no holder qualifies", () => {
    // Dave rolled 100 but min balance is 10 — far below 80% threshold.
    expect(() =>
      buildBonusPayload({
        snapshots: [new Map([[DAVE, 10n]])],
        rolledByHolder: new Map([[DAVE, 100n]]),
        totalReserve: 100n,
      }),
    ).toThrow(/no eligible holders/);
  });
});
