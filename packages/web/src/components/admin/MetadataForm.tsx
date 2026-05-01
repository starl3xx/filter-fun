"use client";

import {useEffect, useState} from "react";
import type {Address} from "viem";
import {useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import deployment from "@/lib/deployment.json";
import {CreatorRegistryAbi} from "@/lib/token/abis";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// Update the on-chain metadata URI for a token. Single field — the contract
/// rejects empty strings, and the form mirrors that gate client-side so users
/// don't burn gas on a sure-revert.

export type MetadataFormProps = {
  token: Address;
  /// Current on-chain URI; surfaces as the placeholder when set, or as a
  /// "currently empty" hint when readers must fall back to the launch event.
  currentUri: string;
  /// When false, the form renders disabled with an explanation. The button
  /// also short-circuits — no tx is sent.
  canEdit: boolean;
};

const REGISTRY_ADDRESS = deployment.addresses.creatorRegistry as Address;

export function MetadataForm({token, currentUri, canEdit}: MetadataFormProps) {
  const [uri, setUri] = useState("");
  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError} =
    useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  useEffect(() => {
    // Once the tx mines, clear the input so the user sees a fresh form
    // (the read of `currentUri` will refresh on the next refetch tick).
    // Do NOT call wagmi's `reset()` here: that clears `txHash`, which makes
    // `useWaitForTransactionReceipt` flip `isSuccess` back to false on the
    // very next render — the "Updated ✓" message would only paint for a
    // single frame. wagmi's next `writeContract()` resets state on its own.
    if (isMined) setUri("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMined]);

  const trimmed = uri.trim();
  const isEmpty = trimmed.length === 0;
  const disabled = !canEdit || isEmpty || isSubmitting || isMining;

  function submit() {
    if (!canEdit || isEmpty) return;
    writeContract({
      address: REGISTRY_ADDRESS,
      abi: CreatorRegistryAbi,
      functionName: "setMetadataURI",
      args: [token, trimmed],
    });
  }

  return (
    <Card label="Metadata URI">
      <p style={{margin: "0 0 8px", fontSize: 12, color: C.dim, fontFamily: F.display}}>
        Point at an IPFS CID or HTTPS URL. Empty strings are rejected on-chain.
      </p>
      <input
        type="text"
        value={uri}
        placeholder={currentUri || "ipfs://… (none set yet)"}
        onChange={(e) => setUri(e.target.value)}
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
      <button
        type="button"
        onClick={submit}
        disabled={disabled}
        data-testid="metadata-submit"
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
              : "Update metadata"}
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
