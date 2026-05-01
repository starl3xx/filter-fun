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
});
