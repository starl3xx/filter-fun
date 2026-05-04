/// Operator-console SIWE-style request signing (Epic 1.21 / spec §47.2).
///
/// Every fetch to `/operator/*` carries a fresh signed message in four headers:
///   Authorization:        `Bearer <0x-prefixed sig>`
///   X-Operator-Address:   `<connected wallet>`
///   X-Operator-Message:   `<the body — see makeOperatorMessage>`
///   X-Operator-Issued-At: `<ISO 8601 now()>`
///
/// The indexer's `decideOperatorAuth` verifies the signature against the
/// message + address and checks the staleness window (5 min).
///
/// The signed message body is human-readable + scoped — operators can audit
/// what their wallet just signed:
///
///   filter.fun operator console
///   action: GET /operator/financial-overview
///   issuedAt: 2026-05-04T20:11:33.012Z
///
/// Caching:
///   - Read fetches don't cache the signature (each request signs fresh) so
///     the staleness window can stay tight. Reads are infrequent (poll-based,
///     not per-keystroke) so the wallet-prompt overhead is acceptable.
///   - For tx-flows the wallet's normal signMessage prompt covers the same
///     surface, so the operator only sees one prompt even though we sign a
///     SIWE message + a tx.

import type {WalletClient} from "viem";

export interface OperatorSignedRequest {
  authorization: string;
  address: string;
  message: string;
  issuedAt: string;
}

export interface OperatorSigner {
  address: `0x${string}`;
  signMessage: (args: {message: string}) => Promise<`0x${string}`>;
}

export function makeOperatorMessage(action: string, issuedAt: string): string {
  return [
    "filter.fun operator console",
    `action: ${action}`,
    `issuedAt: ${issuedAt}`,
  ].join("\n");
}

export async function signOperatorRequest(
  signer: OperatorSigner,
  action: string,
  nowMs: number = Date.now(),
): Promise<OperatorSignedRequest> {
  const issuedAt = new Date(nowMs).toISOString();
  const message = makeOperatorMessage(action, issuedAt);
  const sig = await signer.signMessage({message});
  return {
    authorization: `Bearer ${sig}`,
    address: signer.address,
    message,
    issuedAt,
  };
}

/// Per-(address, action) signature cache. Bugbot PR #95 round 10 (High):
/// pre-fix every `operatorFetch` call invoked `signMessage`, which prompts a
/// wallet popup. The 30s alert-poll loop made the operator console literally
/// unusable — a popup every 30 seconds. The page comment promised "sign once
/// and pull the dashboards" — this cache delivers on that promise.
///
/// Cache TTL: 4 minutes — leaves a 1-minute safety buffer before the server's
/// 5-minute staleness window expires. A cached signature is reused for any
/// fetch with the same `(address, action)` key within that window. The action
/// binding (round 5) means each unique endpoint signs once; the `/alerts`
/// poller signs once every 4 minutes instead of every 30 seconds.
const SIGNATURE_CACHE_TTL_MS = 4 * 60 * 1000;
const signatureCache = new Map<
  string,
  {req: OperatorSignedRequest; expiresAt: number}
>();

/// In-flight signing promises, keyed identically to `signatureCache`. Bugbot
/// PR #95 round 20 (Medium): without this, multiple concurrent callers that
/// observe the same cache miss each call `signer.signMessage` independently,
/// producing a burst of wallet popups before the first sign resolves and
/// repopulates the cache. The operator console hits this on every page-load
/// (alert poll + dashboard load fan out simultaneously) and on every TTL
/// expiry — so up to ~8 concurrent prompts. Coalescing onto one in-flight
/// promise means concurrent misses share a single wallet prompt.
const inflightSigning = new Map<string, Promise<OperatorSignedRequest>>();

/// Cache-aware variant of `signOperatorRequest`. Returns a cached signature
/// for the same (address, action) within the TTL window; otherwise signs
/// fresh and caches the result. Pass a fresh `nowMs` only in tests — production
/// callers default to `Date.now()` so the cached entry's `issuedAt` stays
/// current relative to wall clock.
///
/// This is the function the `operatorFetch` client should call. Tests that
/// want to exercise the raw signing path can still call `signOperatorRequest`
/// directly to bypass the cache.
export async function getCachedOperatorRequest(
  signer: OperatorSigner,
  action: string,
  nowMs: number = Date.now(),
): Promise<OperatorSignedRequest> {
  const key = `${signer.address.toLowerCase()}:${action}`;
  const cached = signatureCache.get(key);
  if (cached && cached.expiresAt > nowMs) {
    return cached.req;
  }
  // In-flight dedup — concurrent callers piggyback on the first one's prompt.
  const existing = inflightSigning.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const req = await signOperatorRequest(signer, action, nowMs);
      signatureCache.set(key, {req, expiresAt: nowMs + SIGNATURE_CACHE_TTL_MS});
      return req;
    } finally {
      // Clear the in-flight slot on BOTH success and error. On error (user
      // rejected the wallet prompt, network blip on EIP-1271 contract
      // wallets), the next caller should be free to retry with a fresh
      // sign rather than awaiting an already-rejected promise forever.
      inflightSigning.delete(key);
    }
  })();
  inflightSigning.set(key, promise);
  return promise;
}

/// Test hook — clears the signature cache between tests. Not used by
/// production code paths.
export function __resetOperatorSignatureCacheForTests(): void {
  signatureCache.clear();
  inflightSigning.clear();
}

/// Convert a signed request into the headers a `fetch` call needs. Co-located
/// with the signer so a future change to header naming lands in one place.
///
/// The signed message body is multi-line (`makeOperatorMessage` joins three
/// lines with `\n` so the wallet prompt is human-readable). Header values
/// per the Fetch spec MUST NOT contain `\n` or `\r` — both browser and
/// Node `fetch` throw `TypeError` constructing such a Headers object.
/// Bugbot PR #95 round 7 (High Severity): pre-fix every `operatorFetch`
/// call would throw before sending, completely breaking the operator
/// console. The fix base64-encodes the body for transport. The signed
/// bytes (and therefore the wallet prompt) are still the human-readable
/// multi-line form; only the over-the-wire header value is encoded. The
/// server base64-decodes before passing to the verifier so the recovered
/// signature still matches the original body.
export function operatorAuthHeaders(req: OperatorSignedRequest): HeadersInit {
  return {
    "Authorization": req.authorization,
    "X-Operator-Address": req.address,
    "X-Operator-Message-B64": encodeMessageForHeader(req.message),
    "X-Operator-Issued-At": req.issuedAt,
  };
}

/// Encode a UTF-8 string as base64 for safe header transport. The signed
/// body is ASCII (`makeOperatorMessage` only builds ASCII strings), so a
/// direct `btoa(message)` would suffice — but we encode through a UTF-8
/// byte path for forward-compat (a future signed field carrying e.g. a
/// multisig name with non-ASCII characters would still encode correctly).
export function encodeMessageForHeader(message: string): string {
  // `btoa` operates on Latin-1 only. Convert to UTF-8 bytes first so any
  // non-ASCII codepoint encodes losslessly.
  const utf8 = new TextEncoder().encode(message);
  let binary = "";
  for (let i = 0; i < utf8.length; i++) {
    binary += String.fromCharCode(utf8[i]!);
  }
  return btoa(binary);
}

/// Adapter: wagmi's WalletClient has the right shape, but its signMessage
/// signature returns a hex string. Wrap it so the operator-console code
/// doesn't depend on the wagmi import.
export function makeWagmiSigner(client: WalletClient): OperatorSigner | null {
  const account = client.account;
  if (!account) return null;
  return {
    address: account.address,
    signMessage: async ({message}) => client.signMessage({account, message}),
  };
}
