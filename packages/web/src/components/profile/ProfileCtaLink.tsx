"use client";

/// Small "View profile" link, shown wherever a panel scoped to a single
/// wallet (e.g. the connected admin's past-tokens list) wants to jump out
/// to that wallet's full profile page. Epic 1.24 (spec §38) cross-link
/// surface — see `CreatorChip.tsx` for the avatar-bearing variant used in
/// per-token surfaces.

import Link from "next/link";

import {C, F} from "@/lib/tokens";

export function ProfileCtaLink({
  address,
  label = "View profile →",
}: {
  address: `0x${string}`;
  label?: string;
}) {
  return (
    <Link
      href={`/p/${address}`}
      style={{
        fontSize: 11,
        fontFamily: F.mono,
        color: C.pink,
        textDecoration: "none",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </Link>
  );
}
