/// localStorage-backed state for the /launch ROI calculator (spec §45.3).
///
/// Persistence is best-effort. Privacy-mode browsers, quota-exceeded errors,
/// and disabled-storage settings all fall back to in-memory state — the
/// calculator still works, the creator just doesn't get the "remember my
/// last hypothetical" affordance.

import {useCallback, useEffect, useState} from "react";

import {PRESETS, type Outcome, type Preset} from "@/lib/launch/economics";

export const STORAGE_KEY = "launch_calculator_state_v1";

export type CalculatorState = {
  peakMcUsd: number;
  weeklyVolumeUsd: number;
  outcome: Outcome;
};

/// Default to the "realistic" preset — most likely outcome, sets creator
/// expectations correctly on first visit (per spec §45.5 risk framing).
const DEFAULT_STATE: CalculatorState = {
  peakMcUsd: PRESETS[0]!.peakMcUsd,
  weeklyVolumeUsd: PRESETS[0]!.weeklyVolumeUsd,
  outcome: PRESETS[0]!.outcome,
};

function readStored(): CalculatorState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CalculatorState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    // Validate every field — a corrupt entry (or a stale v0 schema) shouldn't
    // crash the calculator. Reject anything that doesn't shape-match.
    if (typeof parsed.peakMcUsd !== "number" || !Number.isFinite(parsed.peakMcUsd)) return null;
    if (typeof parsed.weeklyVolumeUsd !== "number" || !Number.isFinite(parsed.weeklyVolumeUsd)) return null;
    if (parsed.outcome !== "filtered" && parsed.outcome !== "survives" && parsed.outcome !== "wins") return null;
    return {
      peakMcUsd: parsed.peakMcUsd,
      weeklyVolumeUsd: parsed.weeklyVolumeUsd,
      outcome: parsed.outcome,
    };
  } catch {
    // SecurityError (privacy mode), SyntaxError (corrupt JSON), QuotaExceeded
    // on subsequent writes — all collapse to "use the default".
    return null;
  }
}

function writeStored(state: CalculatorState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Privacy mode / quota — silently drop.
  }
}

export type UseCalculatorState = {
  state: CalculatorState;
  setPeakMc: (usd: number) => void;
  setWeeklyVolume: (usd: number) => void;
  setOutcome: (outcome: Outcome) => void;
  applyPreset: (preset: Preset) => void;
};

export function useCalculatorState(): UseCalculatorState {
  // Important: initialise from `DEFAULT_STATE` (not the stored value) so the
  // first server render and first client render produce identical markup.
  // We hydrate from localStorage in an effect, after the initial paint.
  // Without this guard Next's hydration check yells at a mismatch.
  const [state, setState] = useState<CalculatorState>(DEFAULT_STATE);

  useEffect(() => {
    const stored = readStored();
    if (stored) setState(stored);
  }, []);

  useEffect(() => {
    writeStored(state);
  }, [state]);

  const setPeakMc = useCallback((usd: number) => {
    setState((s) => ({...s, peakMcUsd: usd}));
  }, []);

  const setWeeklyVolume = useCallback((usd: number) => {
    setState((s) => ({...s, weeklyVolumeUsd: usd}));
  }, []);

  const setOutcome = useCallback((outcome: Outcome) => {
    setState((s) => ({...s, outcome}));
  }, []);

  const applyPreset = useCallback((preset: Preset) => {
    setState({
      peakMcUsd: preset.peakMcUsd,
      weeklyVolumeUsd: preset.weeklyVolumeUsd,
      outcome: preset.outcome,
    });
  }, []);

  return {state, setPeakMc, setWeeklyVolume, setOutcome, applyPreset};
}
