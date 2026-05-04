/// Tests for the operator-request signer adapter — Epic 1.21 / spec §47.2.

import {describe, expect, it} from "vitest";
import {privateKeyToAccount} from "viem/accounts";
import {verifyMessage} from "viem";

import {
  __resetOperatorSignatureCacheForTests,
  encodeMessageForHeader,
  getCachedOperatorRequest,
  makeOperatorMessage,
  operatorAuthHeaders,
  signOperatorRequest,
  type OperatorSigner,
} from "@/lib/operator/auth";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

function makeSigner(): OperatorSigner {
  const account = privateKeyToAccount(PK);
  return {
    address: account.address,
    signMessage: ({message}) => account.signMessage({message}),
  };
}

describe("makeOperatorMessage", () => {
  it("formats the body with action + issuedAt + canonical brand string", () => {
    const m = makeOperatorMessage("GET /operator/alerts", "2026-05-04T20:00:00Z");
    expect(m).toBe(
      [
        "filter.fun operator console",
        "action: GET /operator/alerts",
        "issuedAt: 2026-05-04T20:00:00Z",
      ].join("\n"),
    );
  });
});

describe("signOperatorRequest", () => {
  it("returns headers that round-trip through viem.verifyMessage", async () => {
    const signer = makeSigner();
    const req = await signOperatorRequest(signer, "GET /operator/alerts");
    expect(req.address).toBe(signer.address);
    expect(req.authorization.startsWith("Bearer 0x")).toBe(true);
    expect(req.message).toContain("GET /operator/alerts");
    expect(req.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const sig = req.authorization.replace("Bearer ", "") as `0x${string}`;
    const ok = await verifyMessage({
      address: req.address as `0x${string}`,
      message: req.message,
      signature: sig,
    });
    expect(ok).toBe(true);
  });
});

describe("operatorAuthHeaders", () => {
  it("emits the four canonical header names with a base64-encoded message", () => {
    const headers = operatorAuthHeaders({
      authorization: "Bearer 0xdead",
      address: "0xabcd",
      message: "msg",
      issuedAt: "2026-05-04T00:00:00Z",
    });
    expect(headers).toEqual({
      Authorization: "Bearer 0xdead",
      "X-Operator-Address": "0xabcd",
      "X-Operator-Message-B64": "bXNn", // base64("msg")
      "X-Operator-Issued-At": "2026-05-04T00:00:00Z",
    });
  });

  // Bugbot PR #95 round 7 (High Severity): pre-fix the multi-line signed
  // body was placed directly into `X-Operator-Message`. The Fetch spec
  // forbids `\n` / `\r` (0x0A / 0x0D) in header VALUES — both browser
  // and Node `fetch` throw `TypeError` constructing such a Headers
  // object, so EVERY operator-console fetch failed before sending. The
  // fix base64-encodes the body. This test pins that guarantee: the
  // canonical signed body MUST round-trip through `new Headers()`
  // without throwing.
  it("produces headers that the Fetch API accepts (no forbidden bytes)", async () => {
    const signer = makeSigner();
    const req = await signOperatorRequest(signer, "GET /operator/alerts");
    // The signed body is multi-line — sanity check before testing the
    // header. If this assertion ever flips to single-line we should
    // revisit whether the header-encode path is still needed.
    expect(req.message).toContain("\n");
    const headers = operatorAuthHeaders(req);
    expect(() => new Headers(headers)).not.toThrow();
    // And every header value is `\n` / `\r`-free.
    for (const [, value] of Object.entries(headers as Record<string, string>)) {
      expect(value).not.toMatch(/[\r\n]/);
    }
  });

  it("the encoded message round-trips losslessly through atob", () => {
    const original = makeOperatorMessage("GET /operator/alerts", "2026-05-04T20:00:00Z");
    const encoded = encodeMessageForHeader(original);
    // atob → byte-string; convert byte-string → UTF-8 string for the round-trip.
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(original);
  });

  it("encodes non-ASCII characters losslessly via the UTF-8 byte path", () => {
    // Forward-compat: a future signed field might carry e.g. a multisig
    // name with non-ASCII chars. The encoder MUST go through UTF-8 bytes
    // so codepoints above 0xFF round-trip; a naive `btoa(message)` would
    // throw on these inputs.
    const original = "café — naïve";
    const encoded = encodeMessageForHeader(original);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(original);
  });
});

describe("getCachedOperatorRequest", () => {
  // Bugbot PR #95 round 10 (High Severity): pre-fix every operator-console
  // fetch invoked `signMessage`, prompting a wallet popup on every request.
  // The 30s alert-poll loop made the console literally unusable. This cache
  // reuses the same signed body for 4 minutes per (address, action) pair so
  // polling stays prompt-free.

  function counterSigner(): OperatorSigner & {readonly calls: () => number} {
    const account = privateKeyToAccount(PK);
    let n = 0;
    return {
      address: account.address,
      signMessage: async ({message}) => {
        n++;
        return account.signMessage({message});
      },
      calls: () => n,
    };
  }

  it("reuses the cached signature for the same (address, action) within the TTL window", async () => {
    __resetOperatorSignatureCacheForTests();
    const signer = counterSigner();
    const t0 = Date.UTC(2026, 4, 4, 12, 0, 0);
    const a = await getCachedOperatorRequest(signer, "GET /operator/alerts", t0);
    const b = await getCachedOperatorRequest(signer, "GET /operator/alerts", t0 + 60_000);
    const c = await getCachedOperatorRequest(signer, "GET /operator/alerts", t0 + 3 * 60_000);
    expect(signer.calls()).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("re-signs once the cached entry expires (past 4 minutes)", async () => {
    __resetOperatorSignatureCacheForTests();
    const signer = counterSigner();
    const t0 = Date.UTC(2026, 4, 4, 12, 0, 0);
    await getCachedOperatorRequest(signer, "GET /operator/alerts", t0);
    // Just past the 4-minute TTL — cache should miss.
    await getCachedOperatorRequest(signer, "GET /operator/alerts", t0 + 4 * 60_000 + 1);
    expect(signer.calls()).toBe(2);
  });

  it("caches per action — distinct endpoints sign distinct messages", async () => {
    __resetOperatorSignatureCacheForTests();
    const signer = counterSigner();
    const t0 = Date.UTC(2026, 4, 4, 12, 0, 0);
    const a = await getCachedOperatorRequest(signer, "GET /operator/alerts", t0);
    const b = await getCachedOperatorRequest(signer, "GET /operator/actions", t0);
    expect(signer.calls()).toBe(2);
    expect(a.message).toContain("GET /operator/alerts");
    expect(b.message).toContain("GET /operator/actions");
    // Both still reused on a second call with the same action.
    await getCachedOperatorRequest(signer, "GET /operator/alerts", t0 + 30_000);
    await getCachedOperatorRequest(signer, "GET /operator/actions", t0 + 30_000);
    expect(signer.calls()).toBe(2);
  });

  it("caches per address — different signers don't collide", async () => {
    __resetOperatorSignatureCacheForTests();
    const signerA = counterSigner();
    // Different account, identical action.
    const otherPk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
    const otherAccount = privateKeyToAccount(otherPk);
    let otherCalls = 0;
    const signerB: OperatorSigner = {
      address: otherAccount.address,
      signMessage: async ({message}) => {
        otherCalls++;
        return otherAccount.signMessage({message});
      },
    };
    const t0 = Date.UTC(2026, 4, 4, 12, 0, 0);
    await getCachedOperatorRequest(signerA, "GET /operator/alerts", t0);
    await getCachedOperatorRequest(signerB, "GET /operator/alerts", t0);
    expect(signerA.calls()).toBe(1);
    expect(otherCalls).toBe(1);
  });
});
