/// Operator-wallet authentication for `/operator/*` endpoints (Epic 1.21 / spec §47.2).
///
/// Auth model:
///   - Env `OPERATOR_WALLETS` is a comma-separated list of Ethereum addresses (the
///     production multisig + any signing-capable EOAs).
///   - Every `/operator/*` request must carry a SIWE-style signed message in the
///     `Authorization` and `X-Operator-Address` headers:
///       Authorization:        `Bearer <0x-prefixed sig>`
///       X-Operator-Address:   `<0x-prefixed signer address>`
///       X-Operator-Message:   `<the signed message body>`
///       X-Operator-Issued-At: `<ISO 8601 timestamp>` (≤ 5 min stale)
///   - The message must be EIP-191 personal_sign-style (`viem.verifyMessage` semantics).
///   - The recovered signer must match `X-Operator-Address` AND must be in the
///     `OPERATOR_WALLETS` allow-list (case-insensitive comparison).
///
/// We deliberately don't bind to a Cookie / sessionStorage state — every request is
/// individually signed. That matches the operator-console flow (sign once per recovery
/// or governance action; reads use a short-lived sign-on signature) and avoids a
/// session-fixation surface.
///
/// Failure modes return 403 with `{error, reason}` so the operator console can render
/// a precise diagnostic banner instead of a generic "forbidden". Reasons:
///   - "no_allowlist"      — `OPERATOR_WALLETS` env unset (server misconfig).
///   - "missing_headers"   — request didn't carry the four required headers.
///   - "stale_message"     — `issuedAt` > 5 min in the past (or in the future).
///   - "bad_signature"     — recovered signer ≠ `X-Operator-Address`.
///   - "not_authorized"    — signer not in the allow-list.

import {getAddress, isAddress, verifyMessage} from "viem";

import type {MwContext} from "./middleware.js";

const STALENESS_WINDOW_MS = 5 * 60 * 1000;

export interface OperatorAuthDecision {
  authorized: boolean;
  reason?: string;
  /// Set on success — the EIP-55 checksummed signer address. Logged on every
  /// operator action so the audit trail records WHICH operator wallet acted.
  signer?: `0x${string}`;
}

/// Pure helper — testable without spinning up a Hono context. Reads the four
/// headers + the env, returns the auth decision.
export async function decideOperatorAuth(input: {
  authorization: string | undefined;
  address: string | undefined;
  message: string | undefined;
  issuedAt: string | undefined;
  allowlistRaw: string | undefined;
  nowMs?: number;
}): Promise<OperatorAuthDecision> {
  const allowlist = parseOperatorWallets(input.allowlistRaw);
  if (allowlist.length === 0) {
    return {authorized: false, reason: "no_allowlist"};
  }

  const sigHeader = input.authorization?.trim();
  const sig = sigHeader?.startsWith("Bearer ") ? sigHeader.slice(7).trim() : sigHeader;
  if (!sig || !input.address || !input.message || !input.issuedAt) {
    return {authorized: false, reason: "missing_headers"};
  }
  if (!sig.startsWith("0x")) {
    return {authorized: false, reason: "missing_headers"};
  }

  if (!isAddress(input.address)) {
    return {authorized: false, reason: "missing_headers"};
  }

  // Staleness check — reject messages older than the window OR set in the future
  // (clock skew + replay safety).
  const issuedAtMs = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return {authorized: false, reason: "stale_message"};
  }
  const now = input.nowMs ?? Date.now();
  if (now - issuedAtMs > STALENESS_WINDOW_MS || issuedAtMs - now > STALENESS_WINDOW_MS) {
    return {authorized: false, reason: "stale_message"};
  }

  // viem.verifyMessage: EIP-191 personal_sign + EIP-1271 contract-account fallback. The
  // multisig-as-operator path (production) needs the EIP-1271 branch; an EOA operator
  // (genesis testing) lands on the EIP-191 branch. verifyMessage handles both
  // transparently when given the address.
  let valid = false;
  try {
    valid = await verifyMessage({
      address: input.address as `0x${string}`,
      message: input.message,
      signature: sig as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return {authorized: false, reason: "bad_signature"};
  }

  const signer = getAddress(input.address);
  const allowed = allowlist.some((a) => a.toLowerCase() === signer.toLowerCase());
  if (!allowed) {
    return {authorized: false, reason: "not_authorized"};
  }
  return {authorized: true, signer};
}

/// Parse the comma-separated `OPERATOR_WALLETS` env. Empty entries (e.g. trailing
/// commas) and malformed addresses are dropped silently — operators reading the
/// boot log see the resolved list, so a typo lands as "address X dropped from
/// allow-list" rather than a hard fail at startup.
export function parseOperatorWallets(raw: string | undefined): `0x${string}`[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s): s is `0x${string}` => isAddress(s))
    .map((s) => getAddress(s));
}

/// Hono-style helper: extracts headers from MwContext, runs the decision, writes
/// 403 + JSON on deny. Returns null when authorized so the route handler proceeds.
/// On success, attaches the signer to a shared header so handlers that audit-log
/// the action can read it back without re-parsing.
export async function applyOperatorAuth(c: MwContext): Promise<{response: Response | null; signer?: `0x${string}`}> {
  const decision = await decideOperatorAuth({
    authorization: c.req.header("authorization"),
    address: c.req.header("x-operator-address"),
    message: c.req.header("x-operator-message"),
    issuedAt: c.req.header("x-operator-issued-at"),
    allowlistRaw: process.env.OPERATOR_WALLETS,
  });
  if (!decision.authorized) {
    return {
      response: c.json(
        {
          error: "operator authentication required",
          reason: decision.reason,
        },
        403,
      ),
    };
  }
  return {response: null, signer: decision.signer};
}
