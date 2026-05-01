"use client";

import type {Address} from "viem";
import {zeroAddress} from "viem";
import {useReadContract} from "wagmi";

import deployment from "@/lib/deployment.json";
import {CreatorRegistryAbi} from "@/lib/token/abis";

/// Live read of the per-token admin surface from CreatorRegistry (Epic 1.12).
///
/// Wraps four `useReadContract` calls into a single hook with a unified
/// loading/error signal. All four can be served in parallel by the RPC, and
/// wagmi's react-query layer dedupes them so re-renders that don't change
/// `token` don't re-fire requests.
///
/// Returns the canonical admin/recipient/creator/pendingAdmin/metadataURI for
/// the token. Pre-1.12 tokens (deployed before the override mappings existed)
/// return zero in `pendingAdminOf` and an empty string for `metadataURIOf`;
/// `adminOf` and `recipientOf` resolve to `creatorOf` per the registry's
/// default-resolution rules.

export type TokenAdminInfo = {
  /// `null` means "unknown yet" (loading or unregistered token). Consumers
  /// should treat null as a non-render signal rather than rendering placeholders.
  creator: Address | null;
  admin: Address | null;
  recipient: Address | null;
  pendingAdmin: Address | null;
  metadataURI: string;
};

export type UseTokenAdminResult = {
  info: TokenAdminInfo;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
};

const REGISTRY_ADDRESS = deployment.addresses.creatorRegistry as Address;

export function useTokenAdmin(token: Address | null): UseTokenAdminResult {
  const enabled = Boolean(token) && REGISTRY_ADDRESS !== zeroAddress;

  const creator = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: CreatorRegistryAbi,
    functionName: "creatorOf",
    args: token ? [token] : undefined,
    query: {enabled, refetchInterval: 30_000},
  });
  const admin = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: CreatorRegistryAbi,
    functionName: "adminOf",
    args: token ? [token] : undefined,
    query: {enabled, refetchInterval: 30_000},
  });
  const recipient = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: CreatorRegistryAbi,
    functionName: "recipientOf",
    args: token ? [token] : undefined,
    query: {enabled, refetchInterval: 30_000},
  });
  const pendingAdmin = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: CreatorRegistryAbi,
    functionName: "pendingAdminOf",
    args: token ? [token] : undefined,
    query: {enabled, refetchInterval: 30_000},
  });
  const metadataURI = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: CreatorRegistryAbi,
    functionName: "metadataURIOf",
    args: token ? [token] : undefined,
    query: {enabled, refetchInterval: 60_000},
  });

  const reads = [creator, admin, recipient, pendingAdmin, metadataURI];
  const isLoading = enabled && reads.some((r) => r.isLoading);
  const errorRead = reads.find((r) => r.error);

  // Normalize the zero address to `null` for every address field. The contract
  // returns `address(0)` to signal "unset" (pendingAdmin defaults to zero when
  // no transfer is pending, override mappings start at zero, etc.) — passing
  // that string through as truthy leaks into UIs that branch on `pendingAdmin
  // && (...)` and falsely renders "Pending admin: 0x0000…0000". Normalizing
  // here so every consumer gets the right shape with no per-call zero-check.
  const info: TokenAdminInfo = {
    creator: nullIfZero(creator.data as Address | undefined),
    admin: nullIfZero(admin.data as Address | undefined),
    recipient: nullIfZero(recipient.data as Address | undefined),
    pendingAdmin: nullIfZero(pendingAdmin.data as Address | undefined),
    metadataURI: (metadataURI.data as string | undefined) ?? "",
  };

  return {
    info,
    isLoading,
    error: errorRead?.error ?? null,
    refetch: async () => {
      await Promise.all(reads.map((r) => r.refetch()));
    },
  };
}

function nullIfZero(addr: Address | undefined): Address | null {
  if (!addr) return null;
  return addr === zeroAddress ? null : addr;
}
