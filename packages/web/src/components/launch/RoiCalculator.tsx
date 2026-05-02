"use client";

/// Cost / ROI calculator (spec §45). Lives below the slot grid + form on
/// /launch, lets a creator dial in peak market cap + weekly volume + outcome
/// scenario and see net out-of-pocket, fees, bounty, POL, breakeven update
/// live.
///
/// Architecture:
///   - Math is pure and lives in `lib/launch/economics.ts`. This file only
///     handles state, layout, and event wiring.
///   - State persists to localStorage via `useCalculatorState`. Reset to
///     defaults if the stored entry doesn't shape-validate.
///   - The risk-disclosure block at the top is structurally non-removable —
///     it is rendered by this component and not feature-flagged. Spec §45.5
///     is explicit that it cannot be hidden "for marketing reasons."
///
/// Layout breakpoints:
///   - ≥700px: side-by-side inputs + outputs (single card)
///   - <700px: stacked single-column layout

import {useMemo} from "react";

import {C, F} from "@/lib/tokens";
import {
  ETH_USD_FALLBACK,
  PEAK_MC_SCALE,
  PRESETS,
  WEEKLY_VOLUME_SCALE,
  calculateOutcomes,
  fmtEth4,
  fmtUsd,
  fmtUsdSigned,
  logToValue,
  type Outcome,
  type Preset,
  valueToLog,
} from "@/lib/launch/economics";
import {useCalculatorState} from "@/hooks/launch/useCalculatorState";

export type RoiCalculatorProps = {
  /// Current slot's launch cost in wei (live read from FilterLauncher).
  /// 0n is acceptable — the calculator renders with a "—" output until
  /// the contract read settles.
  slotCostWei: bigint;
  stakeWei: bigint;
  /// ETH/USD rate. Optional — falls back to ETH_USD_FALLBACK.
  ethUsd?: number;
};

const OUTCOME_OPTIONS: ReadonlyArray<{id: Outcome; label: string; sub: string}> = [
  {id: "filtered", label: "Filtered", sub: "Bottom 6 — most likely"},
  {id: "survives", label: "Survives cut", sub: "Top 6, doesn't win"},
  {id: "wins", label: "Wins week", sub: "Single winner"},
];

export function RoiCalculator({slotCostWei, stakeWei, ethUsd: ethUsdProp}: RoiCalculatorProps) {
  const {state, setPeakMc, setWeeklyVolume, setOutcome, applyPreset} = useCalculatorState();
  // Use the shared ETH_USD_FALLBACK so the calculator and CostPanel agree
  // on the rate when no live feed is supplied. A literal would silently
  // diverge from `weiToUsd`'s default if the constant later moves.
  const ethUsd = ethUsdProp ?? ETH_USD_FALLBACK;

  const out = useMemo(
    () =>
      calculateOutcomes({
        peakMcUsd: state.peakMcUsd,
        weeklyVolumeUsd: state.weeklyVolumeUsd,
        outcome: state.outcome,
        slotCostWei,
        stakeWei,
        ethUsd,
      }),
    [state, slotCostWei, stakeWei, ethUsd],
  );

  const slotCostReady = slotCostWei > 0n;

  return (
    <section
      aria-labelledby="roi-calculator-title"
      style={{display: "flex", flexDirection: "column", gap: 12}}
    >
      {/* Risk disclosure — non-removable. Rendered first so it can never be
          scrolled past without seeing it. Visual treatment: red+yellow border
          to read distinct from the calculator card itself. */}
      <RiskDisclosure />

      <div
        className="ff-roi-calculator"
        style={{
          padding: 16,
          borderRadius: 14,
          border: `1px solid ${C.line}`,
          background: "rgba(255,255,255,0.03)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <header style={{display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap"}}>
          <h2
            id="roi-calculator-title"
            style={{
              margin: 0,
              fontFamily: F.display,
              fontWeight: 800,
              fontSize: 16,
              color: C.text,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            What if?
          </h2>
          <span style={{fontSize: 11, color: C.faint, fontFamily: F.mono, letterSpacing: "0.04em"}}>
            Drag sliders or pick a scenario.
          </span>
        </header>

        {/* Preset row — clicking snaps state to the preset's values. */}
        <div role="group" aria-label="Scenario presets" style={{display: "flex", flexWrap: "wrap", gap: 8}}>
          {PRESETS.map((p) => (
            <PresetButton
              key={p.id}
              preset={p}
              active={isActivePreset(state, p)}
              onClick={() => applyPreset(p)}
            />
          ))}
        </div>

        <div className="ff-roi-grid">
          {/* Inputs */}
          <div style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
            <LogSlider
              id="roi-peak-mc"
              label="Estimated peak market cap"
              valueLabel={fmtUsd(state.peakMcUsd)}
              t={valueToLog(state.peakMcUsd, PEAK_MC_SCALE)}
              onChange={(t) => setPeakMc(logToValue(t, PEAK_MC_SCALE))}
              min={fmtUsd(PEAK_MC_SCALE.min)}
              max={fmtUsd(PEAK_MC_SCALE.max)}
            />
            <LogSlider
              id="roi-weekly-volume"
              label="Estimated weekly trading volume"
              valueLabel={fmtUsd(state.weeklyVolumeUsd)}
              t={valueToLog(state.weeklyVolumeUsd, WEEKLY_VOLUME_SCALE)}
              onChange={(t) => setWeeklyVolume(logToValue(t, WEEKLY_VOLUME_SCALE))}
              min={fmtUsd(WEEKLY_VOLUME_SCALE.min)}
              max={fmtUsd(WEEKLY_VOLUME_SCALE.max)}
            />
            <OutcomeRadio value={state.outcome} onChange={setOutcome} />
          </div>

          {/* Outputs */}
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${C.line}`,
              background: "rgba(0,0,0,0.18)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontFamily: F.mono,
                fontSize: 9,
                letterSpacing: "0.16em",
                fontWeight: 800,
                color: C.cyan,
                textTransform: "uppercase",
              }}
            >
              Expected outcome
            </div>

            <OutputRow
              label="Net out-of-pocket"
              value={slotCostReady ? fmtUsdSigned(out.netUsd) : "$—"}
              // Gate the green/profit accent on slotCostReady. With a 0n
              // slot cost the math computes a net of `−creatorFees` (a
              // notional profit) which would render as green + "Net profit"
              // alongside the placeholder "$—" — a misleading flash before
              // the contract read settles.
              accent={!slotCostReady ? C.text : out.netUsd >= 0 ? C.text : C.green}
              hint={
                !slotCostReady
                  ? "Loading current slot cost…"
                  : out.netUsd >= 0
                    ? "Cost across the week (+)"
                    : "Net profit across the week (−)"
              }
            />

            <OutputRow
              label="Creator fees this week"
              value={slotCostReady ? fmtUsd(out.creatorFeesUsd) : "$—"}
              accent={C.green}
              hint={
                state.outcome === "filtered"
                  ? "Half-week of fees — accrual stops at the cut"
                  : "0.20% of weekly volume"
              }
            />

            {state.outcome === "wins" && out.bountyRangeUsd && (
              <OutputRow
                label="Champion bounty"
                value={`${fmtUsd(out.bountyRangeUsd.low)} – ${fmtUsd(out.bountyRangeUsd.high)}`}
                accent={C.yellow}
                hint="2.5% of losers pot — depends on field size"
              />
            )}

            {state.outcome === "wins" && out.polBackingEth !== null && (
              <OutputRow
                label="POL backing"
                value={`~${fmtEth4(out.polBackingEth)} locked LP`}
                accent={C.purple}
                hint="Permanent V4 LP — never withdrawn"
              />
            )}

            <div style={{height: 1, background: C.lineSoft, marginTop: 4}} />
            <OutputRow
              label="Breakeven"
              value={slotCostReady ? fmtUsd(out.breakevenVolumeUsd) : "$—"}
              accent={C.cyan}
              hint="Volume needed to recoup launch cost via 0.20% fees alone"
              compact
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function isActivePreset(state: {peakMcUsd: number; weeklyVolumeUsd: number; outcome: Outcome}, p: Preset): boolean {
  // Strict equality on the snapshot — once the user nudges a slider the
  // preset highlight clears, signalling they're in custom-scenario mode.
  return (
    state.peakMcUsd === p.peakMcUsd &&
    state.weeklyVolumeUsd === p.weeklyVolumeUsd &&
    state.outcome === p.outcome
  );
}

// ============================================================ pieces

function RiskDisclosure() {
  return (
    <div
      role="note"
      aria-label="Risk disclosure"
      style={{
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${C.yellow}66`,
        borderLeft: `4px solid ${C.red}`,
        background: `linear-gradient(180deg, ${C.yellow}10, ${C.red}08)`,
        color: C.text,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 9,
          letterSpacing: "0.18em",
          fontWeight: 800,
          color: C.yellow,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        ▼ Most tokens get filtered
      </div>
      <p style={{margin: 0, fontSize: 13, lineHeight: 1.55, color: C.text}}>
        The realistic outcome of launching on filter.fun is that your token does
        not win and your refundable stake is forfeited. The calculator below
        shows hypothetical scenarios; it does <strong>not</strong> predict outcomes
        for your specific token. Read the{" "}
        <a
          href="https://docs.filter.fun/risks/risk-disclosure"
          target="_blank"
          rel="noreferrer"
          style={{color: C.cyan, textDecoration: "underline"}}
        >
          risk disclosure
        </a>{" "}
        before committing.
      </p>
    </div>
  );
}

function PresetButton({preset, active, onClick}: {preset: Preset; active: boolean; onClick: () => void}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        flex: "1 1 180px",
        minWidth: 0,
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: 10,
        cursor: "pointer",
        border: `1px solid ${active ? C.cyan : C.line}`,
        background: active ? `${C.cyan}14` : "rgba(255,255,255,0.02)",
        color: C.text,
        fontFamily: F.mono,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        transition: "border-color 120ms ease, background 120ms ease",
      }}
    >
      <span style={{fontSize: 12, fontWeight: 800, color: active ? C.cyan : C.text}}>{preset.label}</span>
      <span style={{fontSize: 10, color: C.dim, fontWeight: 500, lineHeight: 1.4}}>{preset.blurb}</span>
    </button>
  );
}

function LogSlider({
  id,
  label,
  valueLabel,
  t,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  valueLabel: string;
  t: number;
  onChange: (t: number) => void;
  min: string;
  max: string;
}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 6}}>
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8}}>
        <label
          htmlFor={id}
          style={{
            fontSize: 10,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {label}
        </label>
        <span
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 14,
            color: C.text,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {valueLabel}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={t}
        onChange={(e) => onChange(Number(e.target.value))}
        className="ff-roi-slider"
        style={{width: "100%"}}
      />
      <div style={{display: "flex", justifyContent: "space-between", fontSize: 10, color: C.faint, fontFamily: F.mono}}>
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function OutcomeRadio({value, onChange}: {value: Outcome; onChange: (o: Outcome) => void}) {
  return (
    <fieldset style={{border: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6}}>
      <legend
        style={{
          padding: 0,
          fontSize: 10,
          fontFamily: F.mono,
          color: C.faint,
          letterSpacing: "0.16em",
          fontWeight: 700,
          textTransform: "uppercase",
          marginBottom: 2,
        }}
      >
        Outcome scenario
      </legend>
      <div style={{display: "flex", gap: 6, flexWrap: "wrap"}}>
        {OUTCOME_OPTIONS.map((opt) => {
          const active = opt.id === value;
          return (
            <label
              key={opt.id}
              style={{
                flex: "1 1 130px",
                minWidth: 0,
                padding: "8px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border: `1px solid ${active ? C.pink : C.line}`,
                background: active ? `${C.pink}14` : "rgba(255,255,255,0.02)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span style={{display: "flex", alignItems: "center", gap: 6}}>
                <input
                  type="radio"
                  name="roi-outcome"
                  value={opt.id}
                  checked={active}
                  onChange={() => onChange(opt.id)}
                  style={{margin: 0}}
                />
                <span style={{fontFamily: F.mono, fontWeight: 800, fontSize: 12, color: active ? C.pink : C.text}}>
                  {opt.label}
                </span>
              </span>
              <span style={{fontSize: 10, color: C.dim, paddingLeft: 22, lineHeight: 1.4}}>{opt.sub}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function OutputRow({
  label,
  value,
  accent,
  hint,
  compact,
}: {
  label: string;
  value: string;
  accent: string;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 2}}>
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8}}>
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 11,
            color: C.dim,
            letterSpacing: "0.04em",
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: compact ? 13 : 15,
            color: accent,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
      </div>
      {hint && (
        <span style={{fontSize: 10, color: C.faint, lineHeight: 1.4}}>
          {hint}
        </span>
      )}
    </div>
  );
}
