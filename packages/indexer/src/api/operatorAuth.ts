/// Operator-wallet authentication for `/operator/*` endpoints (Epic 1.21 / spec §47.2).
///
/// Auth model:
///   - Env `OPERATOR_WALLETS` is a comma-separated list of Ethereum addresses (the
///     production multisig + any signing-capable EOAs).
///   - Every `/operator/*` request must carry a SIWE-style signed message in the
///     `Authorization` and `X-Operator-Address` headers:
///       Authorization:          `Bearer <0x-prefixed sig>`
///       X-Operator-Address:     `<0x-prefixed signer address>`
///       X-Operator-Message-B64: `<base64(utf8(signed message body))>` — the
///                               body is multi-line and the Fetch spec forbids
///                               `\n` / `\r` in header values, so it's
///                               base64-encoded for transport. The verifier
///                               sees the decoded form (signature math is
///                               unchanged).
///       X-Operator-Issued-At:   `<ISO 8601 timestamp>` (≤ 5 min stale)
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
///   - "action_mismatch"   — signed `action:` field ≠ actual HTTP request endpoint.
///   - "bad_signature"     — recovered signer ≠ `X-Operator-Address`.
///   - "not_authorized"    — signer not in the allow-list.

import {createPublicClient, getAddress, http, isAddress} from "viem";
import {base, baseSepolia} from "viem/chains";

import type {MwContext} from "./middleware.js";

const STALENESS_WINDOW_MS = 5 * 60 * 1000;

/// Verifier function shape — given (address, message, signature), returns true
/// if the signature is valid. Production path uses
/// `publicClient.verifyMessage(...)` which handles BOTH EIP-191 (EOA ecrecover)
/// AND EIP-1271 (on-chain `isValidSignature` for smart-contract / multisig
/// accounts). Tests inject a stubbed verifier (or omit, defaulting to the EOA-
/// only utility) so they don't need an RPC connection.
///
/// Audit (bugbot PR #95 round 1, High Severity): the top-level `verifyMessage`
/// utility from `viem` is **EOA-only** by design — viem's own docs warn
/// "Does not support Contract Accounts. It is highly recommended to use
/// publicClient.verifyMessage instead." Production deploys MUST hit the
/// public-client variant or the multisig operator path will silently 403 every
/// request with `bad_signature` (the genesis EOA path keeps working, masking
/// the issue until mainnet rollover).
export type OperatorVerifier = (input: {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
}) => Promise<boolean>;

export interface OperatorAuthDecision {
  authorized: boolean;
  reason?: string;
  /// Set on success — the EIP-55 checksummed signer address. Logged on every
  /// operator action so the audit trail records WHICH operator wallet acted.
  signer?: `0x${string}`;
}

/// Pure helper — testable without spinning up a Hono context. Reads the four
/// headers + the env, returns the auth decision. Inject a custom `verifier`
/// for tests; production callers omit it and the lazy module-singleton wires
/// in the public-client variant (handles EIP-1271).
export async function decideOperatorAuth(input: {
  authorization: string | undefined;
  address: string | undefined;
  message: string | undefined;
  issuedAt: string | undefined;
  allowlistRaw: string | undefined;
  nowMs?: number;
  /// Expected `action:` value the signed message body must contain. Bound to
  /// the actual HTTP request (`${method} ${path}`, no query string) so that a
  /// signature scoped to one endpoint can't be replayed against another within
  /// the staleness window. Bugbot PR #95 round 5 (Medium): pre-fix the server
  /// parsed `issuedAt:` from the body but ignored `action:` entirely, so a
  /// replay-window-fresh signature for `GET /operator/alerts` could be reused
  /// to authenticate `GET /operator/actions`. Optional only for backwards-
  /// compat with the test surface — production callers via `applyOperatorAuth`
  /// always pass it.
  expectedAction?: string;
  /// Override for testing. Defaults to the EOA-only fallback when omitted —
  /// production callers should use `applyOperatorAuth` (below), which wires
  /// in the public-client verifier so EIP-1271 multisig flows work.
  verifier?: OperatorVerifier;
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
  //
  // Bugbot PR #95 round 2 (High): the timestamp MUST come from the signed
  // message body, not from the unsigned `X-Operator-Issued-At` header. Using
  // the header was a replay vulnerability — an attacker who captured a valid
  // operator request could replay it indefinitely by freshening only the
  // header (signature stays valid because the signed message is unchanged).
  // Parse `issuedAt: <ISO>` from the signed body and use THAT. We additionally
  // require the header to match exactly (defense in depth — flags clients
  // that are sending mismatched values, surfaces tampering attempts as a
  // distinct deny reason rather than silently letting one or the other win).
  const signedIssuedAt = parseSignedField(input.message, "issuedAt");
  if (!signedIssuedAt) {
    return {authorized: false, reason: "stale_message"};
  }
  if (signedIssuedAt !== input.issuedAt) {
    // Header tampered post-signing OR client bug. Either way, refuse.
    return {authorized: false, reason: "stale_message"};
  }
  const issuedAtMs = Date.parse(signedIssuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return {authorized: false, reason: "stale_message"};
  }
  const now = input.nowMs ?? Date.now();
  if (now - issuedAtMs > STALENESS_WINDOW_MS || issuedAtMs - now > STALENESS_WINDOW_MS) {
    return {authorized: false, reason: "stale_message"};
  }

  // Action binding (bugbot PR #95 round 5, Medium): the signed message body
  // contains an `action:` line that scopes the signature to ONE endpoint. The
  // server must verify the request is actually hitting that endpoint —
  // otherwise an operator who signs `GET /operator/alerts` could have that
  // signature replayed (within the 5-min window) against `/operator/actions`
  // or any other operator route. We compare exactly: `${METHOD} ${path}`,
  // no query string. Path-level binding (not URL-level) lets the operator
  // change query filters without re-signing, but holds the endpoint identity.
  if (input.expectedAction !== undefined) {
    const signedAction = parseSignedField(input.message, "action");
    if (!signedAction || signedAction !== input.expectedAction) {
      return {authorized: false, reason: "action_mismatch"};
    }
  }

  // EIP-191 personal_sign + EIP-1271 smart-contract-account verification. The
  // injected verifier handles both transparently — production wires in
  // `publicClient.verifyMessage(...)` which falls back to an on-chain
  // `isValidSignature(bytes32,bytes)` call when the address is a contract.
  // The default fallback below is EOA-only (utility-form `verifyMessage`)
  // and is only reached in tests / dev environments where no RPC is
  // configured. See OperatorVerifier docstring for the audit context.
  const verifier = input.verifier ?? defaultEoaVerifier;
  let valid = false;
  try {
    valid = await verifier({
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

/// Parse a `<key>: <value>` line out of the signed message body. The body
/// format is fixed (see `makeOperatorMessage` on the web side):
///
///   filter.fun operator console
///   action: <method path>
///   issuedAt: <ISO>
///
/// Returns `null` if the field isn't present or the value is empty. Tolerates
/// trailing whitespace + CRLF line endings (a stray `\r` from a Windows client
/// shouldn't authorise; but ALSO shouldn't gratuitously deny a well-formed
/// signature — trim defensively).
export function parseSignedField(message: string, key: string): string | null {
  const lines = message.split(/\r?\n/);
  const prefix = `${key}: `;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      const v = line.slice(prefix.length).trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/// Decode `X-Operator-Message-B64` back to the signed message body. The
/// web client base64-encodes the (multi-line, human-readable) body before
/// putting it in the header because the Fetch spec forbids `\n` / `\r` in
/// header values. Bugbot PR #95 round 7 (High): pre-fix the web client
/// sent the raw body, which made every `fetch` to the operator console
/// throw TypeError on Headers construction. Returns `undefined` when the
/// header is absent or the value isn't valid base64 — the missing_headers
/// deny branch picks it up as a normal client misconfig.
export function parseOperatorMessage(b64: string | undefined): string | undefined {
  if (!b64) return undefined;
  try {
    // `Buffer.from(..., "base64")` accepts both standard and url-safe
    // alphabets and silently drops invalid chars. We then UTF-8 decode the
    // resulting bytes back to the original message.
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) return undefined;
    return bytes.toString("utf8");
  } catch {
    return undefined;
  }
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

// ============================================================ verifiers

/// EOA-only fallback. Uses viem's `recoverMessageAddress` directly (the same
/// primitive the top-level `verifyMessage` utility wraps). Reached only when
/// no production verifier is constructed (no RPC configured) — EIP-1271 calls
/// require an RPC, so we'd silently fail if we tried. Logging would be too
/// noisy here (called per-request); the warn fires once at module load when
/// the production verifier can't be constructed.
const defaultEoaVerifier: OperatorVerifier = async ({address, message, signature}) => {
  const {recoverMessageAddress} = await import("viem");
  try {
    const recovered = await recoverMessageAddress({message, signature});
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
};

/// Lazy module-singleton public client used to verify operator signatures via
/// `publicClient.verifyMessage(...)`. Falls back to the EOA-only verifier when
/// no RPC URL is configured (test environments, indexer running without
/// PONDER_RPC_URL_*).
///
/// Re-uses `PONDER_RPC_URL_8453` / `PONDER_RPC_URL_84532` so the operator
/// console works against the same chain the indexer is bound to. The chain
/// selection mirrors `ponder.config.ts` (`PONDER_NETWORK`); a mismatch here
/// would attempt to verify multisig signatures against the wrong chain's
/// state and 403 every legitimate request.
let cachedVerifier: OperatorVerifier | null = null;

function buildProductionVerifier(): OperatorVerifier | null {
  const networkRaw = process.env.PONDER_NETWORK ?? "baseSepolia";
  const network = networkRaw === "base" ? "base" : "baseSepolia";
  const rpcUrl =
    network === "base" ? process.env.PONDER_RPC_URL_8453 : process.env.PONDER_RPC_URL_84532;
  if (!rpcUrl) {
    console.warn(
      `[operator-auth] PONDER_RPC_URL_${network === "base" ? "8453" : "84532"} unset — operator-auth will use the EOA-only verifier. EIP-1271 multisig signatures will be rejected.`,
    );
    return null;
  }
  // Type annotation deliberately omitted: ponder ships its own viem types
  // alongside the workspace viem, and an explicit `PublicClient` here trips a
  // "two different types with this name exist" mismatch under Ponder's narrower
  // generated definitions. Letting TS infer the literal createPublicClient
  // return type keeps the call-site narrow and skips the conflict.
  const chain = network === "base" ? base : baseSepolia;
  const client = createPublicClient({chain, transport: http(rpcUrl)});
  return async ({address, message, signature}) =>
    client.verifyMessage({address, message, signature});
}

export function getOperatorVerifier(): OperatorVerifier {
  if (cachedVerifier) return cachedVerifier;
  cachedVerifier = buildProductionVerifier() ?? defaultEoaVerifier;
  return cachedVerifier;
}

/// Test hook — reset the verifier singleton between tests that exercise the
/// production path. Not exported through the public surface; tests reach for
/// it via the source path.
export function __resetVerifierForTests(): void {
  cachedVerifier = null;
}

/// Hono-style helper: extracts headers from MwContext, runs the decision, writes
/// 403 + JSON on deny. Returns null when authorized so the route handler proceeds.
/// On success, attaches the signer to a shared header so handlers that audit-log
/// the action can read it back without re-parsing.
export async function applyOperatorAuth(c: MwContext): Promise<{response: Response | null; signer?: `0x${string}`}> {
  // Bind the signature to the requested endpoint (method + path, no query
  // string). The web client signs `${method} /operator${pathWithoutQuery}`,
  // and Hono's `c.req.path` returns the same shape (no query) — so a
  // direct equality check is sufficient.
  const expectedAction = `${c.req.method.toUpperCase()} ${c.req.path}`;
  // Bugbot PR #95 round 7 (High): the signed message body is multi-line
  // (`makeOperatorMessage` joins three lines with `\n` so the wallet prompt
  // is human-readable to operators), and per the Fetch spec a header value
  // MUST NOT contain `\n` / `\r` — `fetch` throws TypeError before sending.
  // The web client base64-encodes the body and sends it as
  // `X-Operator-Message-B64`; we decode here so the verifier sees the
  // original signed bytes. `parseOperatorMessage` returns `undefined` on
  // missing/malformed input → the existing `missing_headers` deny path.
  const message = parseOperatorMessage(c.req.header("x-operator-message-b64"));
  const decision = await decideOperatorAuth({
    authorization: c.req.header("authorization"),
    address: c.req.header("x-operator-address"),
    message,
    issuedAt: c.req.header("x-operator-issued-at"),
    allowlistRaw: process.env.OPERATOR_WALLETS,
    expectedAction,
    verifier: getOperatorVerifier(),
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
