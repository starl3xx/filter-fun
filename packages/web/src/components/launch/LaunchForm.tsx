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

import {useEffect, useId, useMemo, useState} from "react";
import {useAccount} from "wagmi";

import type {TokenResponse} from "@/lib/arena/api";
import {C, F, stripDollar} from "@/lib/tokens";
import {canonicalSymbol, validateLaunchFields, type FieldErrors, type LaunchFormFields} from "@/lib/launch/validation";

import {Triangle} from "@/components/Triangle";
import type {LaunchPhase} from "@/hooks/launch/useLaunchToken";
import {useTickerCheck} from "@/hooks/launch/useTickerCheck";
import {CostPanel} from "./CostPanel";
import {CreatorIncentives} from "./CreatorIncentives";

export type LaunchFormProps = {
  /// Slot the next launch will land in.
  slotIndex: number;
  launchCostWei: bigint;
  stakeWei: bigint;
  /// Used for the cost panel + as a fallback for the ticker uniqueness check
  /// (Epic 1.15c moved the primary check to the indexer's
  /// `/season/:id/tickers/check` API which also covers blocklist + cross-season
  /// winner reservations; cohort is kept for fast offline behaviour when the
  /// indexer is unreachable).
  cohort: TokenResponse[];
  /// Current season id — drives the ticker-check API. `null` while the
  /// launcher's `currentSeasonId` is still loading. Until non-null, the
  /// pre-flight check defers and the form falls back to the cohort string match.
  seasonId: number | bigint | null;
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
  /// Audit M-Ux-4 (Phase 1, 2026-05-03): forwarded to CostPanel so the
  /// cost cells render dashes instead of zero values during the launcher
  /// status read. See CostPanel.tsx for rationale.
  costLoading?: boolean;
};

export function LaunchForm({
  slotIndex,
  launchCostWei,
  stakeWei,
  cohort,
  seasonId,
  phase,
  error,
  onSubmit,
  ethUsd,
  championPoolEth,
  costLoading,
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
  // Epic 1.15c — indexer-driven pre-flight check covers format + blocklist +
  // winner_taken + season_taken. Falls back to the local cohort match when
  // the indexer is unreachable or the seasonId is still loading.
  const tickerCheck = useTickerCheck(fields.ticker, seasonId);
  const localCollision = useTickerCollision(fields.ticker, cohort);
  const tickerCollision = tickerCheck.error ?? localCollision;

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

      {/* Audit M-A11y-2 (Phase 1, 2026-05-03): pre-fix the link inputs used
          `aria-label` only — invisible to sighted users with cognitive /
          visual disabilities and a fragile fallback per WCAG 1.3.1. The
          fieldset's `<legend>` ("Links (optional)") covers the group label,
          but each input now also wraps in its own `<LinkField>` with
          visible label text. The visible labels (Website / X / Twitter /
          Farcaster) match the placeholder text — both surfaces stay in
          sync because they're sourced from the same `LinkField` invocation. */}
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
        <LinkField
          label="Website"
          inputType="url"
          placeholder="yourdomain.com"
          value={fields.website ?? ""}
          onChange={(v) => update("website", v)}
        />
        <LinkField
          label="X / Twitter"
          inputType="text"
          // Bugbot follow-up on PR #74: placeholder must NOT include the
          // leading `@` — `validateLaunchFields` rejects twitter values
          // that start with `@` ("Twitter handle without the @ please.").
          // The placeholder is a format hint; suggesting `@handle` would
          // actively guide users toward a value the validator would
          // reject on submit.
          placeholder="handle"
          value={fields.twitter ?? ""}
          onChange={(v) => update("twitter", v)}
        />
        <LinkField
          label="Farcaster"
          inputType="text"
          // Same constraint: validateLaunchFields rejects farcaster values
          // that start with `@`. The build-doc URL constructor wraps the
          // bare handle into `https://warpcast.com/${handle}` so a `.eth`
          // suffix isn't needed either — keep the placeholder a generic
          // hint that matches the validator's expectations.
          placeholder="handle"
          value={fields.farcaster ?? ""}
          onChange={(v) => update("farcaster", v)}
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
        costLoading={costLoading}
      />

      <FilterMechanicHint />

      {/* Audit M-A11y-1 (Phase 1, 2026-05-03): pre-fix the checkbox sat
          inside its parent `<label>` via implicit nesting. Implicit
          association works in most browsers but is fragile for some
          screen-reader / VoiceOver combinations (WCAG 1.3.1). Explicit
          `id` + `htmlFor` makes the pairing unambiguous and survives
          DOM tree movement (e.g. a future portal that moves the input
          out from under the label). */}
      <label
        htmlFor="acknowledge-filtered"
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
          id="acknowledge-filtered"
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
          fontWeight: 800,
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

/// Audit L-A11y-1 (Phase 1, 2026-05-03; bugbot follow-up on PR #74):
/// error/success copy in the launch form lives outside the page-level
/// `<NoticeCard aria-live="polite">` region. Without an aria-live region
/// here, a screen-reader user would silently miss field-validation
/// errors and post-pin / post-tx errors.
///
/// Bugbot follow-up: the earlier draft used `role="alert" aria-live="polite"`,
/// but `role="alert"` carries an implicit `aria-live="assertive"` per the
/// WAI-ARIA spec, and overriding with `polite` produces inconsistent SR
/// behaviour. The spec-correct pairing for polite announcements is
/// `role="status"` (which has an implicit `aria-live="polite"`). The
/// explicit `aria-live="polite"` is kept for parity with NoticeCard's
/// posture and to make intent obvious to a future reader.
function ErrorNotice({children}: {children: React.ReactNode}) {
  return (
    <div
      role="status"
      aria-live="polite"
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

/// Audit M-A11y-2 helper. Each link input gets a visible label (mirrors
/// the placeholder text), uses `useId()` to generate a stable input id /
/// htmlFor pair, and reuses the shared `inputStyle` so the visual surface
/// stays in sync with the rest of the form.
function LinkField({
  label,
  inputType,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  inputType: "url" | "text";
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const inputId = useId();
  return (
    <label htmlFor={inputId} style={{display: "flex", flexDirection: "column", gap: 4}}>
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
      <input
        id={inputId}
        type={inputType}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
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

