"use client";

import {forwardRef, useEffect, useState} from "react";
import type {Address} from "viem";
import {isAddress} from "viem";
import {useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import type {AdminAuthState} from "@/hooks/token/useAdminAuth";
import deployment from "@/lib/deployment.json";
import {CreatorRegistryAbi} from "@/lib/token/abis";
import {addrEq, isZeroAddress, shortAddr} from "@/lib/token/format";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// Two-step admin transfer UI. Three buttons across two roles:
///
///   Current admin:
///     - Nominate (when no pending) → calls `nominateAdmin`
///     - Cancel (when pending exists) → calls `cancelNomination`
///
///   Pending nominee:
///     - Accept → calls `acceptAdmin`
///
/// Single-step "transfer admin" UI is intentionally not offered. The contract
/// won't let you anyway (PR #38 spec §38.6), and surfacing a single button
/// would give users false confidence about a flow that isn't atomic.

export type AdminTransferFormsProps = {
  token: Address;
  currentAdmin: Address | null;
  pendingAdmin: Address | null;
  authState: AdminAuthState;
  /// Audit H-Web-5 — pulse the accept-form wrapper border for ~2s when the
  /// page mounts as PENDING, paired with the auto-scroll. The page owns the
  /// timing (so the pulse and the scroll fire from the same effect); this
  /// component just renders the visual.
  pulseAccept?: boolean;
};

const REGISTRY_ADDRESS = deployment.addresses.creatorRegistry as Address;

/// Forwarded ref so the auth banner can scroll the user to this section when
/// they're the pending nominee.
export const AdminTransferForms = forwardRef<HTMLDivElement, AdminTransferFormsProps>(
  function AdminTransferForms({token, currentAdmin, pendingAdmin, authState, pulseAccept}, ref) {
    // Audit H-Web-4 (Phase 1, 2026-05-01): the hook normalises zero address →
    // null, so the duplicate string-literal compare here is dead but masked a
    // dangerous fallback — if the hook ever stopped normalising, the literal
    // check would silently keep the UI working on `0x0000…` data. Trust the
    // hook's contract; a single null-check is the source of truth.
    const hasPending = pendingAdmin !== null;

    return (
      <div
        ref={ref}
        data-pulse-accept={pulseAccept ? "true" : undefined}
        style={
          pulseAccept
            ? {
                borderRadius: 12,
                outline: `2px solid ${C.pink}`,
                outlineOffset: 2,
                transition: "outline 0.4s ease",
                animation: "ff-pulse 1s ease-in-out 2",
              }
            : undefined
        }
      >
        {authState === "ADMIN" && !hasPending && (
          <NominateForm token={token} currentAdmin={currentAdmin} />
        )}
        {authState === "ADMIN" && hasPending && (
          <CancelForm token={token} pendingAdmin={pendingAdmin!} />
        )}
        {authState === "PENDING" && (
          <AcceptForm token={token} pendingAdmin={pendingAdmin!} />
        )}
        {authState === "READ_ONLY" && hasPending && (
          <Card label="Pending admin transfer">
            <p style={{margin: 0, fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
              Pending admin: <code style={{fontFamily: F.mono}}>{shortAddr(pendingAdmin!)}</code>.
              The current admin remains in control until the nominee accepts.
            </p>
          </Card>
        )}
        {(authState === "DISCONNECTED" || (authState === "READ_ONLY" && !hasPending)) && (
          <Card label="Admin transfer">
            <p style={{margin: 0, fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
              Two-step nominate → accept transfer is mandatory. Connect as the current admin
              to nominate a new wallet.
            </p>
          </Card>
        )}
      </div>
    );
  },
);

// ============================================================ Step 1 — nominate

function NominateForm({token, currentAdmin}: {token: Address; currentAdmin: Address | null}) {
  const [value, setValue] = useState("");
  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError} =
    useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  useEffect(() => {
    // Clear input only — do NOT call wagmi's reset() here. Resetting clears
    // txHash, which makes useWaitForTransactionReceipt flip isSuccess back
    // to false on the next render (success message would only paint for a
    // single frame). The next writeContract() call resets state on its own.
    if (isMined) setValue("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMined]);

  const trimmed = value.trim();
  const isValid = isAddress(trimmed);
  // User-typed input — use the shared `isZeroAddress` helper rather than a
  // string-literal compare, so case-variants of the zero address are also
  // rejected and the same predicate is used everywhere in the codebase.
  const isZero = isZeroAddress(trimmed);
  const isSame = currentAdmin && isValid && addrEq(trimmed, currentAdmin);
  const disabled = !isValid || isZero || Boolean(isSame) || isSubmitting || isMining;

  let validationCopy: string | null = null;
  if (trimmed.length > 0 && !isValid) validationCopy = "Not a valid address";
  else if (isZero) validationCopy = "Zero address rejected";
  else if (isSame) validationCopy = "Already the admin";

  function submit() {
    if (disabled) return;
    writeContract({
      address: REGISTRY_ADDRESS,
      abi: CreatorRegistryAbi,
      functionName: "nominateAdmin",
      args: [token, trimmed as Address],
    });
  }

  return (
    <Card label="Admin transfer · step 1">
      <p style={{margin: "0 0 8px", fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        Nominate the new admin. They must then connect this site and accept — until they
        do, you keep control.
      </p>
      <input
        type="text"
        value={value}
        placeholder="0x… (new admin)"
        onChange={(e) => setValue(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 9,
          background: "rgba(255,255,255,0.04)",
          border: `1px solid ${C.line}`,
          color: C.text,
          fontFamily: F.mono,
          fontSize: 13,
          outline: "none",
        }}
      />
      {validationCopy && (
        <p style={{marginTop: 6, fontSize: 11, color: C.red, fontFamily: F.mono}}>{validationCopy}</p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={disabled}
        data-testid="nominate-submit"
        style={btn(disabled)}
      >
        {isSubmitting ? "Submitting…" : isMining ? "Confirming…" : "Nominate"}
      </button>
      {isMined && (
        <p style={{marginTop: 8, fontSize: 12, color: C.green, fontFamily: F.mono}}>
          Nominated. Have them accept on this page.
        </p>
      )}
      {submitError && (
        <p style={{marginTop: 8, fontSize: 12, color: C.red, fontFamily: F.mono}}>{submitError.message}</p>
      )}
    </Card>
  );
}

// ============================================================ Step 1.5 — cancel pending

function CancelForm({token, pendingAdmin}: {token: Address; pendingAdmin: Address}) {
  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError} =
    useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  // No reset on mine — see NominateForm. The next writeContract() handles
  // it; resetting here flickers the success message away after one frame.

  function submit() {
    writeContract({
      address: REGISTRY_ADDRESS,
      abi: CreatorRegistryAbi,
      functionName: "cancelNomination",
      args: [token],
    });
  }

  return (
    <Card label="Admin transfer · pending">
      <p style={{margin: "0 0 8px", fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        Pending admin: <code style={{fontFamily: F.mono}}>{shortAddr(pendingAdmin)}</code>.
        You can cancel before they accept and re-nominate a different address.
      </p>
      <button
        type="button"
        onClick={submit}
        disabled={isSubmitting || isMining}
        data-testid="cancel-submit"
        style={btnSecondary(isSubmitting || isMining)}
      >
        {isSubmitting ? "Submitting…" : isMining ? "Confirming…" : "Cancel nomination"}
      </button>
      {isMined && (
        <p style={{marginTop: 8, fontSize: 12, color: C.green, fontFamily: F.mono}}>
          Nomination cleared. You can nominate a new wallet now.
        </p>
      )}
      {submitError && (
        <p style={{marginTop: 8, fontSize: 12, color: C.red, fontFamily: F.mono}}>{submitError.message}</p>
      )}
    </Card>
  );
}

// ============================================================ Step 2 — accept

function AcceptForm({token, pendingAdmin}: {token: Address; pendingAdmin: Address}) {
  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError} =
    useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  // No reset on mine — see NominateForm. The next writeContract() handles
  // it; resetting here flickers the success message away after one frame.

  function submit() {
    writeContract({
      address: REGISTRY_ADDRESS,
      abi: CreatorRegistryAbi,
      functionName: "acceptAdmin",
      args: [token],
    });
  }

  return (
    <Card label="Admin transfer · step 2">
      <p style={{margin: "0 0 8px", fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        You've been nominated as the new admin
        (<code style={{fontFamily: F.mono}}>{shortAddr(pendingAdmin)}</code>).
        Accept to take control of this token's metadata, recipient, and admin settings.
      </p>
      <button
        type="button"
        onClick={submit}
        disabled={isSubmitting || isMining}
        data-testid="accept-submit"
        style={btn(isSubmitting || isMining)}
      >
        {isSubmitting ? "Submitting…" : isMining ? "Confirming…" : "Accept admin"}
      </button>
      {isMined && (
        <p style={{marginTop: 8, fontSize: 12, color: C.green, fontFamily: F.mono}}>
          You are the admin.
        </p>
      )}
      {submitError && (
        <p style={{marginTop: 8, fontSize: 12, color: C.red, fontFamily: F.mono}}>{submitError.message}</p>
      )}
    </Card>
  );
}

// ============================================================ shared button styles

function btn(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 10,
    width: "100%",
    padding: "10px 14px",
    borderRadius: 9,
    border: "none",
    background: disabled
      ? "rgba(255,255,255,0.06)"
      : `linear-gradient(135deg, ${C.pink}, ${C.purple})`,
    color: disabled ? C.faint : "#fff",
    fontWeight: 800,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: F.display,
  };
}

function btnSecondary(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 10,
    width: "100%",
    padding: "10px 14px",
    borderRadius: 9,
    border: `1px solid ${C.line}`,
    background: "rgba(255,255,255,0.04)",
    color: disabled ? C.faint : C.text,
    fontWeight: 700,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: F.display,
  };
}
