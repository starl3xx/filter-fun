"use client";

import {useEffect, useState} from "react";
import type {Address} from "viem";
import {isAddress} from "viem";
import {useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import deployment from "@/lib/deployment.json";
import {CreatorRegistryAbi} from "@/lib/token/abis";
import {addrEq, isZeroAddress, shortAddr} from "@/lib/token/format";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// setCreatorRecipient form. Validates: non-empty, valid address, not the
/// zero address (which the contract rejects anyway, but we surface the
/// reason client-side so users don't pay gas to learn it).

export type RecipientFormProps = {
  token: Address;
  currentRecipient: Address | null;
  canEdit: boolean;
};

const REGISTRY_ADDRESS = deployment.addresses.creatorRegistry as Address;

export function RecipientForm({token, currentRecipient, canEdit}: RecipientFormProps) {
  const [value, setValue] = useState("");
  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError} =
    useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  useEffect(() => {
    // Clear the input only — see MetadataForm for why we don't call reset()
    // here (would erase txHash and flicker the success message).
    if (isMined) setValue("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMined]);

  const trimmed = value.trim();
  const isValid = isAddress(trimmed);
  // Audit H-Web-4 — shared helper instead of string-literal compare. Catches
  // case variants and uses one predicate across the codebase.
  const isZero = isZeroAddress(trimmed);
  const isSame = currentRecipient && isValid && addrEq(trimmed, currentRecipient);
  const disabled =
    !canEdit || !isValid || isZero || Boolean(isSame) || isSubmitting || isMining;

  let validationCopy: string | null = null;
  if (trimmed.length > 0 && !isValid) validationCopy = "Not a valid address";
  else if (isZero) validationCopy = "Zero address rejected";
  else if (isSame) validationCopy = "Already the current recipient";

  function submit() {
    if (disabled) return;
    writeContract({
      address: REGISTRY_ADDRESS,
      abi: CreatorRegistryAbi,
      functionName: "setCreatorRecipient",
      args: [token, trimmed as Address],
    });
  }

  return (
    <Card label="Fee recipient">
      <p style={{margin: "0 0 8px", fontSize: 12, color: C.dim, fontFamily: F.display}}>
        Where the 0.20% creator fee flows when you claim.
        Current: <code style={{fontFamily: F.mono}}>{currentRecipient ? shortAddr(currentRecipient) : "—"}</code>
      </p>
      <input
        type="text"
        value={value}
        placeholder="0x…"
        onChange={(e) => setValue(e.target.value)}
        disabled={!canEdit}
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
        <p style={{marginTop: 6, fontSize: 11, color: C.red, fontFamily: F.mono}}>
          {validationCopy}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={disabled}
        data-testid="recipient-submit"
        style={{
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
        }}
      >
        {!canEdit
          ? "Admin only"
          : isSubmitting
            ? "Submitting…"
            : isMining
              ? "Confirming…"
              : "Update recipient"}
      </button>
      {isMined && (
        <p style={{marginTop: 8, fontSize: 12, color: C.green, fontFamily: F.mono}}>Updated ✓</p>
      )}
      {submitError && (
        <p style={{marginTop: 8, fontSize: 12, color: C.red, fontFamily: F.mono}}>
          {submitError.message}
        </p>
      )}
    </Card>
  );
}
