/// GET /api/metadata/[slug]
///
/// Serves a previously-pinned metadata JSON from the filesystem backend.
/// Only used when PINATA_JWT is unset — IPFS-pinned launches never resolve
/// through this route.

import {NextResponse} from "next/server";

import {MetadataStorageError, readFsMetadata} from "@/lib/launch/storage";

export const dynamic = "force-dynamic";

// Forward-compat across Next 14 / 15. Next 14 (pinned at 14.2.35) gives
// `params` synchronously; Next 15 wraps it in a Promise. `await` is a no-op
// on the sync form and unwraps on the Promise form, so this single shape
// works on both. When we upgrade, the type narrows naturally.
export async function GET(_req: Request, ctx: {params: {slug: string} | Promise<{slug: string}>}) {
  try {
    const {slug} = await ctx.params;
    const json = await readFsMetadata(slug);
    return new NextResponse(json, {
      headers: {
        "Content-Type": "application/json",
        // Token metadata is immutable post-launch; cache hard.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const status = err instanceof MetadataStorageError ? err.status : 500;
    const message = err instanceof Error ? err.message : "not found";
    return NextResponse.json({error: message}, {status});
  }
}
