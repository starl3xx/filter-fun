"use client";

/// Set-username modal — Epic 1.24 (spec §38).
///
/// Flow:
///   1. User types a candidate handle. We debounce-check availability against
///      `GET /profile/username/:username/available` so error states render
///      live (taken / blocklisted / format).
///   2. On submit, we ask the wallet to `personal_sign` the canonical message
///      `filter.fun:set-username:<address>:<username>:<nonce>`. The nonce is a
///      random 16-byte hex string per submission — opaque to the server today,
///      but signed so a future replay-protection upgrade doesn't break wallet
///      clients.
///   3. POST `/profile/:address/username` with `{username, signature, nonce}`.
///      Server re-validates everything (format, blocklist, cooldown, taken,
///      signer matches address). Errors map to specific UI copy.
///
/// On success, the parent page receives the new userProfile block and
/// re-renders. We do NOT auto-redirect to `/p/<username>` — that would break
/// browser history (per dispatch §38 #9).

import {useCallback, useEffect, useRef, useState} from "react";
import {useSignMessage} from "wagmi";

import {C, F} from "@/lib/tokens";
import {
  buildSetUsernameMessage,
  fetchUsernameAvailability,
  submitUsername,
  type UserProfileBlock,
  type UsernameAvailability,
} from "@/lib/arena/api";

export type SetUsernameModalProps = {
  address: `0x${string}`;
  /// Existing profile so we can pre-fill the input on a "change username" flow.
  initial: UserProfileBlock;
  onClose: () => void;
  onSuccess: (profile: UserProfileBlock) => void;
};

const AVAILABILITY_DEBOUNCE_MS = 300;

export function SetUsernameModal({address, initial, onClose, onSuccess}: SetUsernameModalProps) {
  const [value, setValue] = useState(initial.usernameDisplay ?? "");
  const [availability, setAvailability] = useState<UsernameAvailability | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const {signMessageAsync} = useSignMessage();

  // Debounced availability check. Reset state on every keystroke; fire the
  // network call after the debounce window. Using a ref-tracked sequence
  // number so a slow earlier response can't clobber a fast later one.
  const seqRef = useRef(0);
  useEffect(() => {
    setSubmitError(null);
    if (value.length === 0) {
      setAvailability(null);
      return;
    }
    if (
      initial.username !== null &&
      value.toLowerCase() === initial.username.toLowerCase()
    ) {
      // Re-confirming own current handle — always "available" from the user's POV.
      setAvailability({available: true});
      return;
    }
    // Bugbot L PR #102 pass-14: clear `availability` BEFORE scheduling the
    // new fetch so the prior verdict doesn't stay on screen during the
    // 300ms debounce window. Without this reset, a user who typed
    // `available-name` (verdict: Available, button enabled) and then
    // changed it to `taken-name` would see the stale Available hint and
    // could click submit + sign a wallet message during the gap before
    // the network call resolves to "taken". The submit-time server check
    // would still reject, but the wallet round-trip is wasted UX.
    setAvailability(null);
    const seq = ++seqRef.current;
    const handle = setTimeout(() => {
      fetchUsernameAvailability(value)
        .then((r) => {
          if (seq === seqRef.current) setAvailability(r);
        })
        .catch(() => {
          if (seq === seqRef.current) setAvailability(null);
        });
    }, AVAILABILITY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [value, initial.username]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (value.length === 0) return;
    if (availability && !availability.available) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const nonce = makeNonce();
      // Bugbot L PR #102 pass-17: pass the already-lowered canonical to
      // `buildSetUsernameMessage` so the call shape mirrors the server
      // (`buildSetUsernameMessage(addr, formatResult.canonical, nonce)`).
      // The function still lowercases internally — pinned by the parity
      // tests on both packages — but expressing the canonical at the
      // call site makes the invariant visible and prevents drift if a
      // future refactor moves the lowercasing to the caller's
      // responsibility. The POST body still ships the raw `value` so
      // the server receives what the user typed and can mirror the
      // display casing on the response (`usernameDisplay`).
      const canonical = value.toLowerCase();
      const message = buildSetUsernameMessage(address, canonical, nonce);
      let signature: `0x${string}`;
      try {
        signature = (await signMessageAsync({message, account: address})) as `0x${string}`;
      } catch {
        // User-rejected the signature in the wallet UI — show specific copy.
        // Wallet errors (user reject, locked) all surface as exceptions; we
        // don't differentiate further because the recovery path is the same:
        // user retries the modal action.
        setSubmitError("Signature rejected — try again.");
        setSubmitting(false);
        return;
      }
      try {
        const r = await submitUsername({address, username: value, signature, nonce});
        if (r.ok) {
          onSuccess(r.profile);
          return;
        }
        setSubmitError(humanizeError(r.error));
      } catch {
        // Bugbot M PR #102 pass-4: `submitUsername` can throw on network
        // failure (DNS, offline, indexer 5xx that the helper wraps). Without
        // an explicit catch the rejection went unhandled and the user only
        // saw the button re-enable with zero feedback. Surface a generic
        // retry-able message — we don't know which network layer failed,
        // so the safest copy is "try again".
        setSubmitError("Network error — try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }, [submitting, value, availability, address, signMessageAsync, onSuccess]);

  const submitDisabled =
    submitting ||
    value.length === 0 ||
    (availability !== null && !availability.available);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set username"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.bg2,
          border: `1px solid ${C.line}`,
          borderRadius: 16,
          padding: 24,
          width: "100%",
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            fontFamily: F.display,
            color: C.text,
          }}
        >
          {initial.hasUsername ? "Change username" : "Set username"}
        </div>
        <div style={{fontSize: 13, color: C.dim, lineHeight: 1.5}}>
          3–32 chars, ASCII letters, digits, dashes. You can change it once
          every 30 days.
        </div>
        <div style={{display: "flex", flexDirection: "column", gap: 6}}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitDisabled) submit();
            }}
            placeholder="starbreaker"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={32}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: C.bg,
              border: `1px solid ${C.line}`,
              color: C.text,
              fontFamily: F.mono,
              fontSize: 16,
              outline: "none",
            }}
          />
          <AvailabilityHint availability={availability} value={value} initial={initial} />
        </div>
        {submitError ? (
          <div style={{color: C.red, fontSize: 13}}>{submitError}</div>
        ) : null}
        <div style={{display: "flex", justifyContent: "flex-end", gap: 8}}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              fontFamily: F.display,
              fontSize: 13,
              fontWeight: 600,
              background: "transparent",
              border: `1px solid ${C.line}`,
              color: C.dim,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitDisabled}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              fontFamily: F.display,
              fontSize: 13,
              fontWeight: 700,
              background: submitDisabled ? `${C.pink}22` : C.pink,
              border: `1px solid ${submitDisabled ? `${C.pink}44` : C.pink}`,
              color: submitDisabled ? C.dim : "#0a0612",
              cursor: submitDisabled ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Signing…" : "Sign and save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AvailabilityHint({
  availability,
  value,
  initial,
}: {
  availability: UsernameAvailability | null;
  value: string;
  initial: UserProfileBlock;
}) {
  if (value.length === 0) return null;
  if (availability === null) {
    return (
      <div style={{fontSize: 12, color: C.faint, fontFamily: F.mono}}>
        Checking…
      </div>
    );
  }
  if (availability.available) {
    const isCurrent =
      initial.username !== null && value.toLowerCase() === initial.username.toLowerCase();
    return (
      <div style={{fontSize: 12, color: C.green, fontFamily: F.mono}}>
        {isCurrent ? "This is your current handle" : "Available"}
      </div>
    );
  }
  const detail =
    availability.reason === "invalid-format"
      ? formatDetail(availability.formatDetail)
      : availability.reason === "taken"
        ? "Already taken"
        : "Reserved word";
  return (
    <div style={{fontSize: 12, color: C.red, fontFamily: F.mono}}>{detail}</div>
  );
}

function formatDetail(detail: string | undefined): string {
  switch (detail) {
    case "too-short":
      return "Too short (min 3 chars)";
    case "too-long":
      return "Too long (max 32 chars)";
    case "invalid-chars":
      return "Use letters, digits, dashes only";
    case "empty":
      return "Required";
    default:
      return "Invalid format";
  }
}

function humanizeError(err: {error: string; status?: number; nextEligibleAt?: string; detail?: string}): string {
  switch (err.error) {
    case "taken":
      return "Username was claimed while you were signing — pick another.";
    case "cooldown-active":
      return err.nextEligibleAt
        ? `Cooldown active until ${new Date(err.nextEligibleAt).toLocaleDateString()}.`
        : "Cooldown active.";
    case "signature mismatch":
      return "Signature didn't match — please retry from your wallet.";
    case "blocklisted username":
      return "That handle is reserved.";
    case "invalid username format":
      return `Invalid format${err.detail ? ` (${err.detail})` : ""}.`;
    case "identity layer unavailable":
      return "Identity service is offline — try again in a moment.";
    default:
      return "Something went wrong — try again.";
  }
}

function makeNonce(): string {
  // 16 random bytes as hex, prefixed `n-` to disambiguate from a
  // hex-only string in logs. The server treats this opaquely.
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `n-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  // Pre-modern environment fallback. Lower entropy but still unique enough
  // for the per-request scope (no replay-protection enforced server-side).
  return `n-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`;
}
