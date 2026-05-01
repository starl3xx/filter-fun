/// GET /api/metadata/[slug]
///
/// Serves a previously-pinned metadata JSON from the filesystem backend.
/// Only used when PINATA_JWT is unset — IPFS-pinned launches never resolve
/// through this route.

import {NextResponse} from "next/server";

import {MetadataStorageError, readFsMetadata} from "@/lib/launch/storage";

export const dynamic = "force-dynamic";

// Next 14 (this project, pinned to 14.2.35) passes `params` synchronously.
// Next 15 changed the signature to `Promise<Params>`; if/when we upgrade,
// the type below changes to `{params: Promise<{slug: string}>}` and the
// access becomes `(await ctx.params).slug`. The contract test suite + the
// upgrade-time typecheck will surface the change.
export async function GET(_req: Request, ctx: {params: {slug: string}}) {
  try {
    const json = await readFsMetadata(ctx.params.slug);
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
