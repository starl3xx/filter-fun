/// Storage backend for the /api/metadata fallback path.
///
/// Two backends are supported, picked at runtime:
///   - PINATA_JWT set        → IPFS pin via Pinata, returns ipfs://<cid>
///   - METADATA_STORE_DIR set→ filesystem-backed fallback, returns a
///                             self-hosted https://…/api/metadata/<slug>
///
/// If NEITHER is set, the route fails loudly. This is intentional — we
/// don't want creators to submit a launch form and discover at the wallet
/// step that there's no metadata URL. Configuring a backend is a deploy
/// requirement, not a runtime nicety.
///
/// The filesystem backend is meant for testnet / preview deploys; it is
/// not intended as a production store. See README — production should
/// always set PINATA_JWT.

import {randomUUID} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";

export type StorageBackend = "pinata" | "fs" | "none";

export type StoredMetadataRef = {
  /// "ipfs://<cid>" or "https://<host>/api/metadata/<slug>".
  uri: string;
  backend: StorageBackend;
};

export function activeBackend(): StorageBackend {
  if (process.env.PINATA_JWT) return "pinata";
  if (process.env.METADATA_STORE_DIR) return "fs";
  return "none";
}

export class MetadataStorageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/// Pin via Pinata's JSON pinning endpoint. Returns ipfs://<cid>.
///
/// Audit L-Sec-2 (Phase 1, 2026-05-03): this fetch is server-side only —
/// the `PINATA_JWT` lives in a non-`NEXT_PUBLIC_` env var (Audit M-Sec-1)
/// and the `/api/metadata` route handler is the only call site. CORS is
/// not relevant: the Pinata endpoint isn't reached by the browser. Do
/// NOT move this fetch client-side; doing so would (a) require shipping
/// the JWT to the browser bundle (instant credential leak) and (b)
/// fail the cross-origin preflight Pinata's API doesn't currently allow.
export async function pinToPinata(doc: Record<string, unknown>): Promise<StoredMetadataRef> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new MetadataStorageError("PINATA_JWT not configured", 500);

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({pinataContent: doc}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MetadataStorageError(
      `Pinata pin failed (${res.status}): ${body.slice(0, 200)}`,
      502,
    );
  }
  const json = (await res.json()) as {IpfsHash?: string};
  if (!json.IpfsHash) throw new MetadataStorageError("Pinata response missing IpfsHash", 502);
  return {uri: `ipfs://${json.IpfsHash}`, backend: "pinata"};
}

/// Filesystem-backed fallback. Writes `<slug>.json` under METADATA_STORE_DIR.
/// The retrieval URL is composed from `METADATA_PUBLIC_URL` (defaults to
/// the request's own origin — the route handler passes that in). Slugs are
/// random UUIDs so two creators can't clobber each other.
export async function pinToFs(
  doc: Record<string, unknown>,
  publicBaseUrl: string,
): Promise<StoredMetadataRef> {
  const dir = process.env.METADATA_STORE_DIR;
  if (!dir) throw new MetadataStorageError("METADATA_STORE_DIR not configured", 500);
  await mkdir(dir, {recursive: true});
  const slug = randomUUID();
  const path = join(dir, `${slug}.json`);
  await writeFile(path, JSON.stringify(doc, null, 2), "utf8");
  const trimmed = publicBaseUrl.replace(/\/+$/, "");
  return {uri: `${trimmed}/api/metadata/${slug}`, backend: "fs"};
}

export async function readFsMetadata(slug: string): Promise<string> {
  const dir = process.env.METADATA_STORE_DIR;
  if (!dir) throw new MetadataStorageError("METADATA_STORE_DIR not configured", 500);
  // Slug guard — prevents `..` traversal. UUIDs are [0-9a-f-] so this is
  // a strict superset; anything else is rejected as 404.
  if (!/^[0-9a-fA-F-]{8,64}$/.test(slug)) throw new MetadataStorageError("not found", 404);
  const path = join(dir, `${slug}.json`);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new MetadataStorageError("not found", 404);
  }
}
