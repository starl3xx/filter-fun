/// Test fixtures for /launch hook + component tests.

import type {LaunchSlot} from "@/hooks/launch/useLaunchSlots";
import type {TokenResponse} from "@/lib/arena/api";

import {makeFixtureCohort} from "../arena/fixtures";

/// Build a 12-slot grid given counts of filled slots. The first `filled`
/// slots get pulled from the arena fixture cohort so each filled card has
/// a real ticker / HP / status to render.
export function makeFixtureSlots(filled: number, opts?: {windowOpen?: boolean}): LaunchSlot[] {
  const windowOpen = opts?.windowOpen ?? true;
  const cohort = makeFixtureCohort();
  const out: LaunchSlot[] = [];
  for (let i = 0; i < 12; i++) {
    if (i < filled) {
      const c = cohort[i]!;
      out.push({
        slotIndex: i,
        kind: "filled",
        token: c.token,
        creator: ("0x" + String(i + 100).padStart(40, "0")) as `0x${string}`,
        costWei: null,
        cohortEntry: c,
      });
      continue;
    }
    if (!windowOpen) {
      out.push({slotIndex: i, kind: "closed", costWei: null});
      continue;
    }
    if (i === filled) {
      out.push({slotIndex: i, kind: "next", costWei: 50000000000000000n /* 0.05 */});
    } else if (i >= 9) {
      out.push({slotIndex: i, kind: "almost", costWei: 84000000000000000n});
    } else {
      out.push({slotIndex: i, kind: "open", costWei: 60000000000000000n});
    }
  }
  return out;
}

export {makeFixtureCohort};

export function makeFixtureTokenCohort(): TokenResponse[] {
  return makeFixtureCohort();
}
