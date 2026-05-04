"use client";

import {useAccount, useWalletClient} from "wagmi";

import {makeWagmiSigner, type OperatorSigner} from "@/lib/operator/auth";
import {isOperator} from "@/lib/operator/config";

/// Drives the four-state auth gating on `/operator`:
///   "DISCONNECTED" — no wallet attached. Render connect CTA.
///   "READ_ONLY"    — connected but not in the allow-list. Render redirect-
///                    away banner; client redirect kicks in via the page.
///   "OPERATOR"     — connected + allow-listed. Full console.
///   "LOADING"      — connected, allow-listed, but wagmi hasn't yet provided
///                    the WalletClient (one-tick window after connect).

export type OperatorAuthState = "DISCONNECTED" | "READ_ONLY" | "OPERATOR" | "LOADING";

export interface OperatorAuth {
  state: OperatorAuthState;
  address: `0x${string}` | null;
  /// Signer ready for `signOperatorRequest`; null while LOADING / DISCONNECTED.
  signer: OperatorSigner | null;
}

export function useOperatorAuth(): OperatorAuth {
  const {address, isConnected} = useAccount();
  const {data: walletClient} = useWalletClient();

  if (!isConnected || !address) {
    return {state: "DISCONNECTED", address: null, signer: null};
  }
  if (!isOperator(address)) {
    return {state: "READ_ONLY", address, signer: null};
  }
  if (!walletClient) {
    return {state: "LOADING", address, signer: null};
  }
  const signer = makeWagmiSigner(walletClient);
  if (!signer) {
    // Unexpected: wagmi gave us a walletClient with no `account`. Treat as
    // LOADING so the UI shows a spinner rather than a misleading "operator"
    // banner without functional sign capability.
    return {state: "LOADING", address, signer: null};
  }
  return {state: "OPERATOR", address, signer};
}
