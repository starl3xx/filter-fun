/// POST /api/metadata
///
/// Receives the launch-form fields, validates server-side, builds the
/// metadata document, pins it (via Pinata if configured, else filesystem),
/// and returns the URI the form passes to `FilterLauncher.launchToken(...)`.
///
/// Two-tier strategy is documented in `lib/launch/storage.ts`:
///   - PINATA_JWT set        → ipfs://<cid> (preferred)
///   - METADATA_STORE_DIR    → self-hosted https://…/api/metadata/<slug>
///   - Neither               → fail loudly with 500
///
/// We re-validate input here even though the form does the same thing on
/// the client — the contract stores `metadataURI` opaquely, so the API is
/// the only enforcement layer that survives a hostile client.

import {NextResponse, type NextRequest} from "next/server";

import {
  activeBackend,
  MetadataStorageError,
  pinToFs,
  pinToPinata,
} from "@/lib/launch/storage";
import {buildMetadataDoc, validateLaunchFields, type LaunchFormFields} from "@/lib/launch/validation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: LaunchFormFields;
  try {
    body = (await req.json()) as LaunchFormFields;
  } catch {
    return NextResponse.json({error: "invalid json"}, {status: 400});
  }

  const errors = validateLaunchFields(body);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({error: "validation failed", fieldErrors: errors}, {status: 400});
  }

  const backend = activeBackend();
  if (backend === "none") {
    return NextResponse.json(
      {
        error:
          "metadata storage not configured: set PINATA_JWT (preferred) or METADATA_STORE_DIR for the filesystem fallback",
      },
      {status: 500},
    );
  }

  const doc = buildMetadataDoc(body);

  try {
    const ref = backend === "pinata" ? await pinToPinata(doc) : await pinToFs(doc, originOf(req));
    return NextResponse.json({uri: ref.uri, backend: ref.backend});
  } catch (err) {
    const status = err instanceof MetadataStorageError ? err.status : 500;
    const message = err instanceof Error ? err.message : "pin failed";
    return NextResponse.json({error: message}, {status});
  }
}

function originOf(req: NextRequest): string {
  const fromEnv = process.env.METADATA_PUBLIC_URL;
  if (fromEnv) return fromEnv;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
