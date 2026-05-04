/// Tests for the operator-request signer adapter — Epic 1.21 / spec §47.2.

import {describe, expect, it} from "vitest";
import {privateKeyToAccount} from "viem/accounts";
import {verifyMessage} from "viem";

import {
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
  it("emits the four canonical header names", () => {
    const headers = operatorAuthHeaders({
      authorization: "Bearer 0xdead",
      address: "0xabcd",
      message: "msg",
      issuedAt: "2026-05-04T00:00:00Z",
    });
    expect(headers).toEqual({
      Authorization: "Bearer 0xdead",
      "X-Operator-Address": "0xabcd",
      "X-Operator-Message": "msg",
      "X-Operator-Issued-At": "2026-05-04T00:00:00Z",
    });
  });
});
