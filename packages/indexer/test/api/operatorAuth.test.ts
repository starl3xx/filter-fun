/// Tests for the pure `decideOperatorAuth` helper — Epic 1.21 / spec §47.2.
///
/// The route layer is a thin wrapper that pulls four headers from the request
/// and writes a 403 on deny. Pinning the decision logic here is sufficient to
/// cover every failure-reason branch + the success path.

import {describe, expect, it} from "vitest";
import {privateKeyToAccount} from "viem/accounts";

import {decideOperatorAuth, parseOperatorWallets} from "../../src/api/operatorAuth.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const SIGNER = privateKeyToAccount(PK).address;

async function signedHeaders(message: string, issuedAt = new Date().toISOString()) {
  const account = privateKeyToAccount(PK);
  const signature = await account.signMessage({message});
  return {
    authorization: `Bearer ${signature}`,
    address: account.address,
    message,
    issuedAt,
  };
}

describe("decideOperatorAuth", () => {
  it("denies with no_allowlist when OPERATOR_WALLETS is unset", async () => {
    const headers = await signedHeaders("hello");
    const r = await decideOperatorAuth({...headers, allowlistRaw: undefined});
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("no_allowlist");
  });

  it("denies with missing_headers when any of the four are absent", async () => {
    const r = await decideOperatorAuth({
      authorization: undefined,
      address: SIGNER,
      message: "hi",
      issuedAt: new Date().toISOString(),
      allowlistRaw: SIGNER,
    });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("missing_headers");
  });

  it("denies with missing_headers when address is malformed", async () => {
    const headers = await signedHeaders("hello");
    const r = await decideOperatorAuth({
      ...headers,
      address: "0xnot-an-address",
      allowlistRaw: SIGNER,
    });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("missing_headers");
  });

  it("denies with stale_message when issuedAt is older than 5 minutes", async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const headers = await signedHeaders("hello", stale);
    const r = await decideOperatorAuth({...headers, allowlistRaw: SIGNER});
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("stale_message");
  });

  it("denies with stale_message when issuedAt is in the future", async () => {
    const future = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    const headers = await signedHeaders("hello", future);
    const r = await decideOperatorAuth({...headers, allowlistRaw: SIGNER});
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("stale_message");
  });

  it("denies with bad_signature when the sig was made by a different key", async () => {
    const headers = await signedHeaders("hello");
    // Swap the message AFTER signing so the signature no longer matches the body.
    const r = await decideOperatorAuth({
      ...headers,
      message: "hello-tampered",
      allowlistRaw: SIGNER,
    });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("bad_signature");
  });

  it("denies with not_authorized when the signer is not in the allow-list", async () => {
    const headers = await signedHeaders("hello");
    const r = await decideOperatorAuth({
      ...headers,
      allowlistRaw: "0x000000000000000000000000000000000000dEaD",
    });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe("not_authorized");
  });

  it("authorizes a valid SIWE-style request", async () => {
    const headers = await signedHeaders("Operator console GET /operator/alerts at 2026-05-04");
    const r = await decideOperatorAuth({...headers, allowlistRaw: SIGNER});
    expect(r.authorized).toBe(true);
    expect(r.signer?.toLowerCase()).toBe(SIGNER.toLowerCase());
  });

  it("authorizes when the allow-list contains the signer with mixed case + extra entries", async () => {
    const headers = await signedHeaders("hello");
    const r = await decideOperatorAuth({
      ...headers,
      allowlistRaw: ` 0x000000000000000000000000000000000000dEaD , ${SIGNER.toLowerCase()} `,
    });
    expect(r.authorized).toBe(true);
  });
});

describe("parseOperatorWallets", () => {
  it("returns empty when the env is unset / blank", () => {
    expect(parseOperatorWallets(undefined)).toEqual([]);
    expect(parseOperatorWallets("")).toEqual([]);
    expect(parseOperatorWallets(",,,")).toEqual([]);
  });

  it("drops malformed addresses silently", () => {
    const r = parseOperatorWallets(`${SIGNER},not-an-address,0x1234`);
    expect(r).toHaveLength(1);
    expect(r[0]).toBe(SIGNER);
  });

  it("checksums the parsed addresses", () => {
    const lower = SIGNER.toLowerCase();
    const r = parseOperatorWallets(lower);
    expect(r[0]).toBe(SIGNER);
  });
});
