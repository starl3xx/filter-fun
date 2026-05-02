/// Audit H-Arena-2 (Phase 1, 2026-05-01) regression — HpBar status-driven gradient.
///
/// Pre-fix the bar derived a single fill colour from HP value alone (75+ cyan,
/// 50+ green, 30+ orange, else red), ignoring the row's status entirely. The spec
/// gradient is intentional: finalist/safe/risk should read at-a-glance from the
/// bar's hue, not its length. Pin the spec map here so a regression that drops
/// the status prop or re-derives colour from HP value surfaces in CI.
import {describe, expect, it} from "vitest";

import {STATUS_GRADIENT} from "../../src/components/arena/HpBar.js";

describe("HpBar STATUS_GRADIENT spec lock (Audit H-Arena-2)", () => {
  it("FINALIST is yellow → pink", () => {
    expect(STATUS_GRADIENT.FINALIST).toEqual(["#ffe933", "#ff3aa1"]);
  });

  it("SAFE is green → cyan", () => {
    expect(STATUS_GRADIENT.SAFE).toEqual(["#52ff8b", "#00f0ff"]);
  });

  it("AT_RISK is red → pink", () => {
    expect(STATUS_GRADIENT.AT_RISK).toEqual(["#ff2d55", "#ff3aa1"]);
  });

  it("FILTERED reuses AT_RISK red→pink (post-cut still reads urgency)", () => {
    expect(STATUS_GRADIENT.FILTERED).toEqual(STATUS_GRADIENT.AT_RISK);
  });

  it("every TokenStatus has a gradient (no implicit fallback to HP-bucket)", () => {
    // If a new status is added to TokenStatus without a STATUS_GRADIENT entry,
    // TS catches it at compile time — but pin the runtime map shape too so a
    // regression that prunes an entry surfaces here.
    expect(Object.keys(STATUS_GRADIENT).sort()).toEqual([
      "AT_RISK",
      "FILTERED",
      "FINALIST",
      "SAFE",
    ]);
  });
});
