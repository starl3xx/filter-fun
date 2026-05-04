/// Tests for the operator-request signer adapter — Epic 1.21 / spec §47.2.

import {describe, expect, it} from "vitest";
import {privateKeyToAccount} from "viem/accounts";
import {verifyMessage} from "viem";

import {
  encodeMessageForHeader,
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
