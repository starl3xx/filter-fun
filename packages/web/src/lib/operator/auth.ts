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
