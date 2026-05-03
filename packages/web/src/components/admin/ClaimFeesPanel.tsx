"use client";

import type {Address} from "viem";

import type {AdminAuth} from "@/hooks/token/useAdminAuth";
import {useCreatorFees} from "@/hooks/token/useCreatorFees";
import {addrEq, fmtEthShort, shortAddr} from "@/lib/token/format";
import {C, F} from "@/lib/tokens";

import {Card, Field} from "./Card";

/// Accumulated WETH + claim button. Two states drive what the button says:
///
///   - Wallet not connected → "Connect to claim" (passive CTA, no action)
///   - Wallet is creator + has pending → "Claim Ξ0.34" (active)
///   - Wallet is creator + no pending → disabled "Nothing to claim"
///   - Wallet is connected but is NOT creator → disabled w/ "Only the creator
///     can trigger a claim" copy. The creator triggers; funds land at the
///     `recipient`. Since admin-transfer doesn't move creator identity, the
///     button is gated by *creator*, not admin.
///
/// In-flight tx surfaces as "Sign in wallet…" → "Confirming…" → flips
/// to "Claim confirmed." on success. Audit M-Ux-8 (Phase 1, 2026-05-03):
/// the four admin sub-forms (this, MetadataForm, AdminTransferForms,
/// BagLockCard) all follow the same 3-state pattern, vocabulary
/// normalized to match the launch flow's SnapshotBadge phase labels
/// ("Sign in your wallet…" / "Broadcasting…" → here "Confirming…"
/// because the receipt-wait stage is what the admin forms call out).

export type ClaimFeesPanelProps = {
  token: Address;
  creator: Address | null;
  recipient: Address | null;
  auth: AdminAuth;
};

export function ClaimFeesPanel({token, creator, recipient, auth}: ClaimFeesPanelProps) {
  const fees = useCreatorFees(token);
  const isCreator = auth.connected !== null && addrEq(auth.connected, creator);
  const recipientLabel = recipient ? shortAddr(recipient) : "—";
  const isDelegated = creator && recipient && !addrEq(creator, recipient);

  const disabled =
    !isCreator || fees.pending === 0n || fees.isSubmitting || fees.isMining;

  let label: string;
  if (auth.state === "DISCONNECTED") {
    label = "Connect to claim";
  } else if (!isCreator) {
    label = "Only the creator can claim";
  } else if (fees.isSubmitting) {
    label = "Sign in wallet…";
  } else if (fees.isMining) {
    label = "Confirming…";
  } else if (fees.pending === 0n) {
    label = "Nothing to claim";
  } else {
    label = `Claim ${fmtEthShort(fees.pending)}`;
  }

  return (
    <Card label="Creator fees">
      <Field k="Pending" v={fmtEthShort(fees.pending)} />
      <Field k="Recipient" v={recipientLabel} />
      <Field
        k="Eligibility"
        v={
          fees.eligible ? (
            <span style={{color: C.green}}>active</span>
          ) : (
            <span style={{color: C.faint}}>window closed</span>
          )
        }
      />
      {isDelegated && (
        <p style={{marginTop: 8, fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
          Fees flow to the configured recipient. The creator triggers the claim, but
          WETH lands at <code style={{fontFamily: F.mono}}>{recipientLabel}</code>.
        </p>
      )}
      <button
        type="button"
        onClick={() => fees.claim()}
        disabled={disabled}
        style={{
          marginTop: 12,
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
          boxShadow: disabled ? "none" : `0 4px 16px ${C.pink}55`,
          opacity: disabled ? 0.7 : 1,
        }}
      >
        {label}
      </button>
      {fees.isMined && (
        <p style={{marginTop: 8, fontSize: 12, color: C.green, fontFamily: F.mono}}>
          Claim confirmed.
        </p>
      )}
      {fees.submitError && (
        <p style={{marginTop: 8, fontSize: 12, color: C.red, fontFamily: F.mono}}>
          {fees.submitError.message}
        </p>
      )}
    </Card>
  );
}
