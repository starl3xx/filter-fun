/// Operator-console configuration sourced at module-load time.
///
/// `NEXT_PUBLIC_OPERATOR_WALLETS` is a comma-separated allow-list of operator
/// addresses (mirrors the indexer's `OPERATOR_WALLETS` env). Set at build time
/// and inlined into the bundle by Next.js — there is no server-side fetch for
/// this list. The list ALSO governs server-side access on the indexer; the
/// client-side check is a UX gate (redirect non-operators to `/`) so the
/// `/operator` route never even renders for the wrong wallet.
///
/// The two env vars MUST match in production. A mismatch surfaces as either
/// (a) the operator console rendering then 403'ing every API call, or (b)
/// non-operator wallets seeing a useless dashboard. Document both in the
/// runbook + flag any drift in CI.

import {getAddress, isAddress} from "viem";

export type OperatorAllowlist = `0x${string}`[];

export function parseOperatorAllowlist(raw: string | undefined): OperatorAllowlist {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s): s is `0x${string}` => isAddress(s))
    .map((s) => getAddress(s));
}

/// Build-time-resolved allow-list. Reading process.env at module scope is the
/// right shape for Next.js NEXT_PUBLIC_* vars (they're inlined into the bundle
/// at build time; subsequent process.env mutations have no effect).
export const OPERATOR_ALLOWLIST: OperatorAllowlist = parseOperatorAllowlist(
  process.env.NEXT_PUBLIC_OPERATOR_WALLETS,
);

export function isOperator(address: string | null | undefined): boolean {
  if (!address) return false;
  if (!isAddress(address)) return false;
  const checksummed = getAddress(address);
  return OPERATOR_ALLOWLIST.some((a) => a.toLowerCase() === checksummed.toLowerCase());
}
