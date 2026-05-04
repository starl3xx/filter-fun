/// Pure unit test for `buildSlotRows` — asserts the kind-mapping invariants
/// the contract + spec define. Exercising the pure builder directly avoids
/// having to mock wagmi to test the hook's slot-shape logic.

import {describe, expect, it} from "vitest";

import {buildSlotRows} from "@/hooks/launch/useLaunchSlots";

import {makeFixtureCohort} from "../arena/fixtures";

const status = {
  launchCount: 8,
  maxLaunches: 12,
  timeRemainingSec: 10_000,
  nextLaunchCostWei: 84000000000000000n,
};

function filled(addr: string, slotIndex: number) {
  return [slotIndex, {token: addr as `0x${string}`, creator: "0x0000000000000000000000000000000000000111" as `0x${string}`}] as const;
}

describe("buildSlotRows", () => {
  it("maps the next-empty slot to kind=next, almost from #10, open below", () => {
    const cohort = makeFixtureCohort();
    const filledMap = new Map(cohort.slice(0, 8).map((t, i) => filled(t.token, i)));
    const slots = buildSlotRows({status, filledMap, cohort});

    expect(slots).toHaveLength(12);
    expect(slots[8]?.kind).toBe("next");
    // Slots 9, 10, 11 are >= ALMOST_GONE_FROM_SLOT (=9) → almost.
    expect(slots[9]?.kind).toBe("almost");
    expect(slots[10]?.kind).toBe("almost");
    expect(slots[11]?.kind).toBe("almost");
    // Slots 0-7 are filled.
    for (let i = 0; i < 8; i++) {
      expect(slots[i]?.kind).toBe("filled");
    }
  });

  it("marks empty slots as closed when window is closed", () => {
    const closedStatus = {...status, launchCount: 4, timeRemainingSec: 0};
    const cohort = makeFixtureCohort();
    const filledMap = new Map(cohort.slice(0, 4).map((t, i) => filled(t.token, i)));
    const slots = buildSlotRows({status: closedStatus, filledMap, cohort});
    for (let i = 4; i < 12; i++) {
      expect(slots[i]?.kind).toBe("closed");
    }
  });

  it("marks filled-pending when contract has the slot but indexer hasn't", () => {
    const cohort = makeFixtureCohort();
    const filledMap = new Map([filled("0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead", 0)]);
    const slots = buildSlotRows({
      status: {...status, launchCount: 1},
      filledMap,
      cohort,
    });
    expect(slots[0]?.kind).toBe("filled-pending");
  });

  it("scales empty-slot cost preview from nextLaunchCost", () => {
    const cohort = makeFixtureCohort();
    const filledMap = new Map(cohort.slice(0, 8).map((t, i) => filled(t.token, i)));
    const slots = buildSlotRows({status, filledMap, cohort});

    // Slot 8's cost === status.nextLaunchCostWei.
    expect(slots[8]?.costWei).toBe(status.nextLaunchCostWei);
    // Slot 11 is more expensive than slot 8.
    expect(slots[11]!.costWei).toBeGreaterThan(slots[8]!.costWei!);
  });

  // ============================================================ Epic 1.15c

  it("overlays reserved-pending kind on empty slots from the reservation map", () => {
    const cohort = makeFixtureCohort();
    const filledMap = new Map<number, {token: `0x${string}`; creator: `0x${string}`}>();
    const reservationMap = new Map([
      [
        2,
        {
          status: "PENDING" as const,
          creator: "0x000000000000000000000000000000000000c0de" as `0x${string}`,
          tickerHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
          escrowAmountWei: 50_000_000_000_000_000n,
        },
      ],
    ]);
    const slots = buildSlotRows({
      status: {...status, launchCount: 0},
      filledMap,
      reservationMap,
      cohort,
    });
    expect(slots[2]?.kind).toBe("reserved-pending");
    expect(slots[2]?.creator).toBe("0x000000000000000000000000000000000000c0de");
    expect(slots[2]?.reservation?.escrowAmountWei).toBe(50_000_000_000_000_000n);
    // Slot 0 is the next-empty since the reservation at slot 2 doesn't fill 0.
    expect(slots[0]?.kind).toBe("next");
  });

  it("uses reserved-refund-pending kind when reservation status is REFUND_PENDING", () => {
    const cohort = makeFixtureCohort();
    const filledMap = new Map<number, {token: `0x${string}`; creator: `0x${string}`}>();
    const reservationMap = new Map([
      [
        5,
        {
          status: "REFUND_PENDING" as const,
          creator: "0x000000000000000000000000000000000000c0de" as `0x${string}`,
          tickerHash: "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`,
          escrowAmountWei: 100_000_000_000_000_000n,
        },
      ],
    ]);
    const slots = buildSlotRows({
      status: {...status, launchCount: 0},
      filledMap,
      reservationMap,
      cohort,
    });
    expect(slots[5]?.kind).toBe("reserved-refund-pending");
  });

  it("filled rows still take precedence over reservations on the same slot index", () => {
    // Edge case: a slot finalised through `launchProtocolToken` AFTER an
    // earlier reservation row was indexed; both sources reference slotIndex
    // 0, but `filledMap` (the contract's authoritative `getLaunchSlots`)
    // wins. This guards against a race where the indexer hasn't caught up
    // with the reservation status flip yet.
    const cohort = makeFixtureCohort();
    const filledMap = new Map([filled(cohort[0]!.token, 0)]);
    const reservationMap = new Map([
      [
        0,
        {
          status: "PENDING" as const,
          creator: "0x000000000000000000000000000000000000c0de" as `0x${string}`,
          tickerHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
          escrowAmountWei: 50_000_000_000_000_000n,
        },
      ],
    ]);
    const slots = buildSlotRows({
      status: {...status, launchCount: 1},
      filledMap,
      reservationMap,
      cohort,
    });
    expect(slots[0]?.kind).toBe("filled");
  });
});
