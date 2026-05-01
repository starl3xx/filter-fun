"use client";

import {useAccount} from "wagmi";

import {addrEq} from "@/lib/token/format";

import type {TokenAdminInfo} from "./useTokenAdmin";

/// Resolves the connected wallet's relationship to a token's admin slot. Drives
/// the four-state auth gating in the admin console:
///
///   "DISCONNECTED" — no wallet attached.
///   "ADMIN"        — connected wallet equals `info.admin`.
///   "PENDING"      — connected wallet equals `info.pendingAdmin` (waiting to
///                    accept; cannot yet drive admin actions).
///   "READ_ONLY"    — connected, but neither admin nor pending. Forms render
///                    disabled with a "you are not the admin" CTA.

export type AdminAuthState = "DISCONNECTED" | "ADMIN" | "PENDING" | "READ_ONLY";

export type AdminAuth = {
  state: AdminAuthState;
  /// Connected wallet address (or null when disconnected). Surfaced for the
  /// "wrong wallet?" copy in the read-only banner.
  connected: `0x${string}` | null;
};

export function useAdminAuth(info: TokenAdminInfo): AdminAuth {
  const {address, isConnected} = useAccount();
  if (!isConnected || !address) {
    return {state: "DISCONNECTED", connected: null};
  }
  if (info.admin && addrEq(address, info.admin)) {
    return {state: "ADMIN", connected: address};
  }
  if (info.pendingAdmin && addrEq(address, info.pendingAdmin)) {
    return {state: "PENDING", connected: address};
  }
  return {state: "READ_ONLY", connected: address};
}
