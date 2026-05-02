/// Hook tests for `useCalculatorState` — localStorage round-trip + graceful
/// fallback when storage isn't available.

import {act, renderHook} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {STORAGE_KEY, useCalculatorState} from "@/hooks/launch/useCalculatorState";
import {PRESETS} from "@/lib/launch/economics";

describe("useCalculatorState", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts at the realistic preset on first load", () => {
    const {result} = renderHook(() => useCalculatorState());
    expect(result.current.state.outcome).toBe(PRESETS[0]!.outcome);
    expect(result.current.state.peakMcUsd).toBe(PRESETS[0]!.peakMcUsd);
  });

  it("persists slider changes to localStorage", () => {
    const {result} = renderHook(() => useCalculatorState());
    act(() => {
      result.current.setPeakMc(123_456);
    });
    const stored = window.localStorage.getItem(STORAGE_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.peakMcUsd).toBe(123_456);
  });

  it("restores prior state on mount", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({peakMcUsd: 999_999, weeklyVolumeUsd: 250_000, outcome: "wins"}),
    );
    const {result} = renderHook(() => useCalculatorState());
    // Effect-based restore — assert after mount.
    expect(result.current.state.peakMcUsd).toBe(999_999);
    expect(result.current.state.weeklyVolumeUsd).toBe(250_000);
    expect(result.current.state.outcome).toBe("wins");
  });

  it("does not stomp stored state with DEFAULT_STATE on mount", () => {
    // Regression: the write effect used to fire on mount with DEFAULT_STATE
    // before the read effect's setState landed, overwriting the user's
    // saved scenario. Strict Mode (Next.js dev default) made it permanent
    // by re-mounting and re-reading the just-stomped default.
    const stored = {peakMcUsd: 777_777, weeklyVolumeUsd: 333_333, outcome: "survives"};
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    renderHook(() => useCalculatorState());
    // After mount the localStorage value must NOT be the default — the
    // hydration latch should have prevented the initial write.
    const after = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(after.peakMcUsd).toBe(777_777);
    expect(after.outcome).toBe("survives");
  });

  it("falls back to defaults on corrupt JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const {result} = renderHook(() => useCalculatorState());
    expect(result.current.state.outcome).toBe(PRESETS[0]!.outcome);
  });

  it("falls back to defaults on shape-invalid stored values", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({peakMcUsd: "fifty thousand", weeklyVolumeUsd: 100_000, outcome: "wins"}),
    );
    const {result} = renderHook(() => useCalculatorState());
    expect(result.current.state.outcome).toBe(PRESETS[0]!.outcome);
  });

  it("rejects an unknown outcome value", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({peakMcUsd: 50_000, weeklyVolumeUsd: 100_000, outcome: "rugpull"}),
    );
    const {result} = renderHook(() => useCalculatorState());
    expect(result.current.state.outcome).toBe(PRESETS[0]!.outcome);
  });

  it("survives setItem throwing (privacy mode / quota exceeded)", () => {
    // Override setItem to throw — emulates Safari private mode pre-2022.
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error("QuotaExceeded");
    });
    try {
      const {result} = renderHook(() => useCalculatorState());
      // Should not throw — error is swallowed by the writer.
      expect(() => act(() => result.current.setPeakMc(42))).not.toThrow();
      expect(result.current.state.peakMcUsd).toBe(42);
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("applyPreset replaces all three fields atomically", () => {
    const {result} = renderHook(() => useCalculatorState());
    act(() => {
      result.current.applyPreset(PRESETS[2]!); // viral
    });
    expect(result.current.state.outcome).toBe("wins");
    expect(result.current.state.peakMcUsd).toBe(PRESETS[2]!.peakMcUsd);
    expect(result.current.state.weeklyVolumeUsd).toBe(PRESETS[2]!.weeklyVolumeUsd);
  });
});
