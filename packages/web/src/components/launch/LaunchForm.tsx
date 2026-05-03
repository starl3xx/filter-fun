"use client";

/// /launch claim form (spec §18.5).
///
/// Lives in the right column on desktop, stacks below the slot grid on
/// mobile. Drives client-side validation, ticker uniqueness check (against
/// the indexer's /tokens response — the chain enforces uniqueness too, but
/// catching it here saves a wasted gas estimate), and the launch button
/// gating.
///
/// Ownership of the launch tx itself lives in the page (`/launch/page.tsx`)
/// — this component just calls `onSubmit(fields)` once everything checks
/// out. The page wires that into pin → write → redirect.

import {useEffect, useMemo, useState} from "react";
import {useAccount} from "wagmi";

import type {TokenResponse} from "@/lib/arena/api";
import {C, F, stripDollar} from "@/lib/tokens";
import {canonicalSymbol, validateLaunchFields, type FieldErrors, type LaunchFormFields} from "@/lib/launch/validation";

import {Triangle} from "@/components/Triangle";
import type {LaunchPhase} from "@/hooks/launch/useLaunchToken";
import {CostPanel} from "./CostPanel";
import {CreatorIncentives} from "./CreatorIncentives";

export type LaunchFormProps = {
  /// Slot the next launch will land in.
  slotIndex: number;
  launchCostWei: bigint;
  stakeWei: bigint;
  /// Used for ticker collision check.
  cohort: TokenResponse[];
  /// Tx phase from useLaunchToken — drives button copy and lock.
  phase: LaunchPhase;
  /// Server-side error from pin or chain reverts.
  error: string | null;
  /// Submit handler called only when all client checks pass. May be async
  /// (the page's handler awaits a metadata pin before the launch tx); the
  /// form fires-and-forgets and lets the parent surface errors via `error`.
  onSubmit: (fields: LaunchFormFields) => void | Promise<void>;
  /// ETH/USD rate for the cost-panel USD column. Optional — falls back to
  /// `ETH_USD_FALLBACK` when omitted.
  ethUsd?: number;
  /// Live champion pool (decimal-ETH from /season). Drives the bounty range
  /// display. Optional — falls back to a quiet-week heuristic.
  championPoolEth?: number | null;
};

export function LaunchForm({
  slotIndex,
  launchCostWei,
  stakeWei,
  cohort,
  phase,
  error,
  onSubmit,
  ethUsd,
  championPoolEth,
}: LaunchFormProps) {
  const {isConnected} = useAccount();
  const [fields, setFields] = useState<LaunchFormFields>({
    name: "",
    ticker: "",
    description: "",
    imageUrl: "",
    website: "",
    twitter: "",
    farcaster: "",
  });
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const fieldErrors = useMemo<FieldErrors>(() => validateLaunchFields(fields), [fields]);
  const tickerCollision = useTickerCollision(fields.ticker, cohort);

  const submitDisabled =
    !isConnected ||
    Object.keys(fieldErrors).length > 0 ||
    tickerCollision !== null ||
    !acknowledged ||
    phase === "pinning" ||
    phase === "signing" ||
    phase === "broadcasting" ||
    // After a successful launch the page redirects via useEffect; the button
    // briefly shows "Launched ▼" until that redirect commits. Disable it so
    // a fast double-click in that window can't kick off a second pin + tx.
    phase === "success";

  function update<K extends keyof LaunchFormFields>(key: K, value: LaunchFormFields[K]) {
    setFields((f) => ({...f, [key]: value}));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    // Audit M-Web-2 (Phase 1, 2026-05-02; bugbot follow-up on PR #72): the
    // genuinely-stale input at click time is `tickerCollision` — that hook
    // debounces with a 200 ms setTimeout, so a user who types a colliding
    // ticker and clicks before the timer fires gets a stale
    // `tickerCollision === null` and submits through. The other gating
    // inputs (`fieldErrors` from useMemo, `acknowledged` / `isConnected` /
    // `phase` from React state) are already current at render time, so
    // re-deriving them here would just reproduce the same values. Re-run
    // ONLY the collision check at click time against the live `cohort`.
    const liveCollision = cohort.some(
      (t) => stripDollar(t.ticker).toUpperCase() === canonicalSymbol(fields.ticker),
    );
    if (submitDisabled || liveCollision) return;
    // Fire-and-forget: the parent's handler is async (pin → launch) and owns
    // its error surface via the `error` prop. `void` marks the intentional
    // discard so any rejection that escapes the parent's try/catch becomes a
    // proper unhandled-rejection rather than silently dropping.
    void Promise.resolve(onSubmit({...fields, ticker: canonicalSymbol(fields.ticker)}));
  }

  const showError = (key: keyof LaunchFormFields): string | undefined => {
    if (!submitted && fields[key] === "") return undefined;
    return fieldErrors[key];
  };

  return (
    <form
      id="launch-form"
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 18,
        borderRadius: 14,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <h2 style={{margin: 0, fontFamily: F.display, fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", gap: 6}}>
          <span aria-hidden>✨</span> Claim a slot
        </h2>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 99,
            border: `1px solid ${C.cyan}55`,
            background: `${C.cyan}1a`,
            color: C.cyan,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 9,
            letterSpacing: "0.16em",
          }}
        >
          SLOT #{String(slotIndex + 1).padStart(2, "0")}
        </span>
      </div>

      <Field
        label="Token name"
        hint="2–32 characters."
        error={showError("name")}
      >
        <input
          type="text"
          maxLength={48}
          placeholder="Filtermaxx"
          value={fields.name}
          onChange={(e) => update("name", e.target.value)}
          style={inputStyle}
        />
      </Field>

      <div style={{display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10}}>
        <Field
          label="Ticker"
          hint="2–10 chars · A–Z · 0–9"
          error={showError("ticker") ?? (tickerCollision ?? undefined)}
        >
          <div style={{display: "flex", alignItems: "center", gap: 6}}>
            <span style={{color: C.faint, fontFamily: F.mono, fontWeight: 800}}>$</span>
            <input
              type="text"
              maxLength={10}
              placeholder="MAXX"
              value={fields.ticker}
              onChange={(e) => update("ticker", e.target.value.toUpperCase())}
              style={{...inputStyle, textTransform: "uppercase"}}
            />
          </div>
        </Field>
        <Field label="Image URL" hint="https:// link to your logo" error={showError("imageUrl")}>
          <input
            type="url"
            placeholder="https://…"
            value={fields.imageUrl}
            onChange={(e) => update("imageUrl", e.target.value)}
            style={inputStyle}
          />
        </Field>
      </div>

      <Field label="Description" hint="16–280 characters." error={showError("description")}>
        <textarea
          rows={3}
          maxLength={400}
          placeholder="One line. Make it sharp."
          value={fields.description}
          onChange={(e) => update("description", e.target.value)}
          style={{...inputStyle, resize: "vertical"}}
        />
      </Field>

      <fieldset style={{border: "none", padding: 0, margin: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10}}>
        <legend
          style={{
            padding: 0,
            fontSize: 9,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 700,
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          Links (optional)
        </legend>
        <input
          type="url"
          placeholder="Website"
          value={fields.website}
          onChange={(e) => update("website", e.target.value)}
          style={inputStyle}
          aria-label="Website"
        />
        <input
          type="text"
          placeholder="X / Twitter"
          value={fields.twitter}
          onChange={(e) => update("twitter", e.target.value)}
          style={inputStyle}
          aria-label="Twitter handle"
        />
        <input
          type="text"
          placeholder="Farcaster"
          value={fields.farcaster}
          onChange={(e) => update("farcaster", e.target.value)}
          style={inputStyle}
          aria-label="Farcaster handle"
        />
      </fieldset>
      {(showError("website") || showError("twitter") || showError("farcaster")) && (
        <ErrorNotice>
          {showError("website") || showError("twitter") || showError("farcaster")}
        </ErrorNotice>
      )}

      <CreatorIncentives />

      <CostPanel
        slotIndex={slotIndex}
        launchCostWei={launchCostWei}
        stakeWei={stakeWei}
        ethUsd={ethUsd}
        championPoolEth={championPoolEth}
      />

      <FilterMechanicHint />

      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: 12,
          borderRadius: 10,
          border: `1px solid ${C.red}55`,
          background: "rgba(255, 45, 85, 0.06)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          style={{marginTop: 2}}
        />
        <span style={{fontSize: 12, color: C.text, lineHeight: 1.45}}>
          I understand most tokens get filtered <Triangle size={12} inline />
        </span>
      </label>

      <button
        type="submit"
        disabled={submitDisabled}
        style={{
          background: submitDisabled
            ? "rgba(255,255,255,0.06)"
            : "linear-gradient(135deg, #ff3aa1, #9c5cff)",
          color: submitDisabled ? C.faint : "#fff",
          border: "none",
          padding: "14px 16px",
          borderRadius: 10,
          fontWeight: 900,
          fontSize: 14,
          cursor: submitDisabled ? "not-allowed" : "pointer",
          letterSpacing: "0.04em",
          boxShadow: submitDisabled ? "none" : "0 8px 24px rgba(255, 58, 161, 0.4)",
        }}
      >
        {buttonCopy(phase, !isConnected)}
      </button>

      {error && <ErrorNotice>{error}</ErrorNotice>}
    </form>
  );
}

function buttonCopy(phase: LaunchPhase, notConnected: boolean): string {
  if (notConnected) return "Connect wallet to launch";
  switch (phase) {
    case "pinning":
      return "Pinning metadata…";
    case "signing":
      return "Sign transaction in wallet…";
    case "broadcasting":
      return "Launching…";
    case "success":
      return "Launched ▼";
    default:
      return "Launch token →";
  }
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{display: "flex", flexDirection: "column", gap: 4}}>
      <span
        style={{
          fontSize: 9,
          fontFamily: F.mono,
          color: C.faint,
          letterSpacing: "0.16em",
          fontWeight: 700,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
      {error ? (
        <span style={{fontSize: 11, color: C.red}}>{error}</span>
      ) : hint ? (
        <span style={{fontSize: 10, color: C.faint}}>{hint}</span>
      ) : null}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  background: "rgba(0,0,0,0.3)",
  color: C.text,
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  padding: "10px 12px",
  fontFamily: F.mono,
  fontSize: 13,
  outline: "none",
};

function ErrorNotice({children}: {children: React.ReactNode}) {
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        border: `1px solid ${C.red}55`,
        background: `${C.red}10`,
        color: C.red,
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

function FilterMechanicHint() {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.02)",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <Triangle size={18} />
      <div style={{minWidth: 0}}>
        <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 13, color: C.text}}>The filter</div>
        <div style={{fontSize: 11, color: C.dim, lineHeight: 1.45, marginTop: 2}}>
          Top 6 survive Friday's cut. Bottom 6 are filtered. Their liquidity funds the winner.
        </div>
      </div>
    </div>
  );
}

/// Returns a per-tick error message if the canonical ticker collides with
/// any current cohort entry, else `null`. Indexer-driven; the chain enforces
/// the same rule but the form catches it before we waste gas.
function useTickerCollision(rawTicker: string, cohort: TokenResponse[]): string | null {
  const [collision, setCollision] = useState<string | null>(null);
  useEffect(() => {
    const sym = canonicalSymbol(rawTicker);
    if (sym.length < 2) {
      setCollision(null);
      return;
    }
    const id = setTimeout(() => {
      const taken = cohort.some((t) => stripDollar(t.ticker).toUpperCase() === sym);
      setCollision(taken ? `$${sym} is already launched this season.` : null);
    }, 200);
    return () => clearTimeout(id);
  }, [rawTicker, cohort]);
  return collision;
}

