/// Tests for the per-token coalescing scheduler — Epic 1.17b.
///
/// We inject a fake timer + clock so the assertions are deterministic and
/// the test runs in milliseconds regardless of the configured window. The
/// scheduler exposes `pendingKeys()` for observability.

import {describe, expect, it} from "vitest";

import {createCoalescingScheduler, withLatencySla} from "../../src/api/coalescing.js";

interface FakeTimer {
  now: () => number;
  advance: (ms: number) => void;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

function fakeTimer(): FakeTimer {
  let nowMs = 0;
  const queue: Array<{at: number; cb: () => void; cancelled: boolean}> = [];
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
      // Fire any callbacks whose deadlines have passed, in order.
      while (true) {
        const next = queue
          .filter((e) => !e.cancelled)
          .sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > nowMs) break;
        next.cancelled = true;
        next.cb();
      }
    },
    setTimer: (cb, ms) => {
      const entry = {at: nowMs + ms, cb, cancelled: false};
      queue.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      (handle as {cancelled: boolean}).cancelled = true;
    },
  };
}

describe("CoalescingScheduler", () => {
  it("100 schedules within window → exactly 1 fire", async () => {
    const t = fakeTimer();
    let fires = 0;
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
    });
    for (let i = 0; i < 100; i++) sched.schedule("tokenA", () => {fires++;});
    expect(fires).toBe(0);
    t.advance(999);
    expect(fires).toBe(0);
    t.advance(1);
    expect(fires).toBe(1);
  });

  it("subsequent schedules within window replace the action but keep the deadline", async () => {
    const t = fakeTimer();
    const calls: string[] = [];
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
    });
    sched.schedule("tokenA", () => {calls.push("first");});
    t.advance(500);
    sched.schedule("tokenA", () => {calls.push("second");});
    t.advance(500);
    // Deadline closes at 1000ms from the FIRST schedule, not 1500ms from
    // the second. Only the latest action runs.
    expect(calls).toEqual(["second"]);
  });

  it("different keys are independent", async () => {
    const t = fakeTimer();
    const fires: string[] = [];
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
    });
    sched.schedule("A", () => {fires.push("A");});
    t.advance(300);
    sched.schedule("B", () => {fires.push("B");});
    t.advance(700);
    // A's window closed at t=1000; B's window opened at t=300 and closes
    // at t=1300. Only A has fired so far.
    expect(fires).toEqual(["A"]);
    t.advance(300);
    expect(fires).toEqual(["A", "B"]);
  });

  it("clear cancels a pending fire without affecting other keys", () => {
    const t = fakeTimer();
    const fires: string[] = [];
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
    });
    sched.schedule("A", () => {fires.push("A");});
    sched.schedule("B", () => {fires.push("B");});
    expect(sched.pendingKeys().sort()).toEqual(["A", "B"]);
    sched.clear("A");
    expect(sched.pendingKeys()).toEqual(["B"]);
    t.advance(1000);
    expect(fires).toEqual(["B"]);
  });

  it("clearAll cancels every pending fire", () => {
    const t = fakeTimer();
    const fires: string[] = [];
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
    });
    for (const k of ["A", "B", "C"]) sched.schedule(k, () => {fires.push(k);});
    sched.clearAll();
    t.advance(2000);
    expect(fires).toEqual([]);
    expect(sched.pendingKeys()).toEqual([]);
  });

  it("a key fires AGAIN after its window closes (subsequent schedule opens a new window)", async () => {
    const t = fakeTimer();
    const fires: string[] = [];
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
    });
    sched.schedule("A", () => {fires.push("A1");});
    t.advance(1000);
    expect(fires).toEqual(["A1"]);
    // After the first window closed, the key is no longer pending — a new
    // schedule opens a fresh window.
    sched.schedule("A", () => {fires.push("A2");});
    t.advance(1000);
    expect(fires).toEqual(["A1", "A2"]);
  });

  it("an action that throws does not poison other keys' fires", () => {
    const t = fakeTimer();
    const fires: string[] = [];
    const errs: Array<{key: unknown; err: unknown}> = [];
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
      onError: (key, err) => errs.push({key, err}),
    });
    sched.schedule("A", () => {throw new Error("bad action");});
    sched.schedule("B", () => {fires.push("B");});
    t.advance(1000);
    expect(fires).toEqual(["B"]);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.key).toBe("A");
  });

  it("schedule returns the deadline (epoch ms) for diagnostics", () => {
    const t = fakeTimer();
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
    });
    const fireAt = sched.schedule("A", () => {});
    // Returned deadline equals now() + windowMs (epoch-ms).
    expect(fireAt).toBe(1000);
    // Subsequent calls within the window return the SAME deadline.
    t.advance(500);
    const fireAt2 = sched.schedule("A", () => {});
    expect(fireAt2).toBe(1000);
  });

  it("async actions: rejection is surfaced via onError", async () => {
    const t = fakeTimer();
    const errs: Array<{key: unknown; err: unknown}> = [];
    const sched = createCoalescingScheduler<string>({
      windowMs: 1000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: t.now,
      onError: (key, err) => errs.push({key, err}),
    });
    sched.schedule("A", async () => {
      throw new Error("async fail");
    });
    t.advance(1000);
    // Allow the rejection's microtask to run.
    await new Promise((res) => setImmediate(res));
    expect(errs).toHaveLength(1);
    expect(errs[0]!.key).toBe("A");
  });
});

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
