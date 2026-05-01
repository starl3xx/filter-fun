/// API route tests for /api/metadata.
///
/// We import the route handler directly and call it with a Web `Request`,
/// avoiding the cost of spinning up a real Next dev server. The handler
/// uses `request.url` to derive the public origin for the filesystem
/// fallback path, so the request URL matters for that branch.

import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it, beforeEach, vi} from "vitest";

import {POST} from "@/app/api/metadata/route";

type MetaResponse = {uri?: string; backend?: string; error?: string; fieldErrors?: Record<string, string>};

const validBody = {
  name: "Filtermaxx",
  ticker: "MAXX",
  description: "A token built to survive the filter and fund the winner.",
  imageUrl: "https://cdn.example.com/logo.png",
};

function makePostRequest(body: unknown, url = "https://filter.fun/api/metadata"): Request {
  return new Request(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
}

describe("POST /api/metadata", () => {
  let storeDir: string | null = null;

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "ff-meta-"));
    delete process.env.PINATA_JWT;
    delete process.env.METADATA_PUBLIC_URL;
    process.env.METADATA_STORE_DIR = storeDir;
  });

  afterEach(async () => {
    if (storeDir) await rm(storeDir, {recursive: true, force: true});
    delete process.env.METADATA_STORE_DIR;
    delete process.env.PINATA_JWT;
    delete process.env.METADATA_PUBLIC_URL;
    storeDir = null;
    vi.restoreAllMocks();
  });

  it("rejects malformed JSON with 400", async () => {
    const req = new Request("https://filter.fun/api/metadata", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: "{not json",
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it("rejects validation errors with 400 + per-field details", async () => {
    const res = await POST(makePostRequest({...validBody, ticker: "lowercase!"}) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as MetaResponse;
    expect(json.fieldErrors).toBeDefined();
    expect(json.fieldErrors?.ticker).toBeDefined();
  });

  it("survives hostile-client payloads without crashing", async () => {
    // Empty object → all required fields missing → structured 400, NOT TypeError.
    const empty = await POST(makePostRequest({}) as never);
    expect(empty.status).toBe(400);
    const emptyJson = (await empty.json()) as MetaResponse;
    expect(emptyJson.fieldErrors?.name).toBeDefined();
    expect(emptyJson.fieldErrors?.ticker).toBeDefined();

    // Non-string values where strings are expected → same path.
    const bad = await POST(makePostRequest({name: 42, ticker: null, description: {}, imageUrl: []}) as never);
    expect(bad.status).toBe(400);
    const badJson = (await bad.json()) as MetaResponse;
    expect(badJson.fieldErrors).toBeDefined();
  });

  it("falls back to fs storage when PINATA_JWT not set", async () => {
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as MetaResponse;
    expect(json.backend).toBe("fs");
    expect(json.uri).toMatch(/^https:\/\/filter\.fun\/api\/metadata\/[0-9a-fA-F-]{8,}$/);
  });

  it("uses METADATA_PUBLIC_URL when set", async () => {
    process.env.METADATA_PUBLIC_URL = "https://override.example";
    const res = await POST(makePostRequest(validBody) as never);
    const json = (await res.json()) as MetaResponse;
    expect(json.uri).toMatch(/^https:\/\/override\.example\/api\/metadata\//);
  });

  it("fails loudly when neither backend is configured", async () => {
    delete process.env.METADATA_STORE_DIR;
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(500);
    const json = (await res.json()) as MetaResponse;
    expect(json.error).toMatch(/not configured/i);
  });

  it("uses Pinata when PINATA_JWT is set", async () => {
    process.env.PINATA_JWT = "fake-jwt";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({IpfsHash: "Qm123abc"}), {status: 200}) as never,
    );
    const res = await POST(makePostRequest(validBody) as never);
    const json = (await res.json()) as MetaResponse;
    expect(json.backend).toBe("pinata");
    expect(json.uri).toBe("ipfs://Qm123abc");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      expect.objectContaining({method: "POST"}),
    );
  });

  it("surfaces Pinata failures as 502", async () => {
    process.env.PINATA_JWT = "fake-jwt";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Pinata down", {status: 503}) as never,
    );
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(502);
  });
});
