/// Tests for the latency-SLA wrapper — Epic 1.17b.
///
/// Per-token coalescing is tested indirectly via the writer's SQL pre-check
/// (covered by handler integration tests, since the check is bound to a
/// transaction-scoped `context.db`). This file pins the latency-SLA
/// instrumentation behavior used by the swap + holder-balance handlers.

import {describe, expect, it} from "vitest";

import {withLatencySla} from "../../src/api/coalescing.js";

describe("withLatencySla", () => {
  it("returns the action's result on success", async () => {
    const r = await withLatencySla("test", 100, async () => 42, {info: () => {}});
    expect(r).toBe(42);
  });

  it("rethrows the action's error", async () => {
    await expect(
      withLatencySla("test", 100, async () => {throw new Error("nope");}, {info: () => {}, warn: () => {}}),
    ).rejects.toThrow("nope");
  });

  it("logs a warning when elapsed > slaMs", async () => {
    const warns: Array<{msg: string; fields: Record<string, unknown>}> = [];
    await withLatencySla(
      "test",
      0, // any elapsed time will breach
      async () => {
        await new Promise((res) => setTimeout(res, 5));
        return 1;
      },
      {info: () => {}, warn: (msg, fields) => warns.push({msg, fields})},
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain("SLA breach");
    expect(warns[0]!.fields.label).toBe("test");
  });

  it("logs info when within SLA", async () => {
    const infos: Array<{msg: string; fields: Record<string, unknown>}> = [];
    await withLatencySla(
      "test",
      10_000,
      async () => 1,
      {info: (msg, fields) => infos.push({msg, fields}), warn: () => {}},
    );
    expect(infos).toHaveLength(1);
    expect(infos[0]!.fields.label).toBe("test");
  });
});
