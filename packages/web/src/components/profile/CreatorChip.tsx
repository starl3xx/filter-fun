"use client";

/// Cross-link chip — Epic 1.24 (spec §38). A small `<UserAvatar>` + truncated
/// handle/address that links to `/p/<address>`. Used wherever a viewer should
/// be able to "see who built this":
///
///   - ArenaTokenDetail (right panel) — links from the selected token's
///     creator to the creator's profile.
///   - PastTokensPanel header (admin console) — links the connected admin
///     to their own profile.
///   - Token admin BagLockCard — links the displayed creator-of-record to
///     their profile.

import Link from "next/link";

import {C, F} from "@/lib/tokens";
import {shortAddr} from "@/lib/token/format";

import {UserAvatar} from "./UserAvatar";

export type CreatorChipProps = {
  address: `0x${string}`;
  /// Optional display label override — typically null/undefined; the chip
  /// shows the truncated address. Pass a username when you have it cached
  /// (e.g. from the parent page's profile data) to avoid the chip refetching.
  label?: string | null;
  size?: "sm" | "md";
  /// Forward an aria-label override when needed for context (e.g. "Creator
  /// of $FILTER"). Default uses the label or address.
  ariaLabel?: string;
};

export function CreatorChip({address, label, size = "sm", ariaLabel}: CreatorChipProps) {
  const text = label && label.length > 0 ? label : shortAddr(address);
  return (
    <Link
      href={`/p/${address}`}
      aria-label={ariaLabel ?? `View profile of ${text}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px 2px 2px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.04)",
        border: `1px solid ${C.line}`,
        textDecoration: "none",
        color: C.text,
        fontFamily: F.mono,
        fontSize: size === "md" ? 12 : 11,
        letterSpacing: "0.02em",
        maxWidth: "100%",
      }}
    >
      <UserAvatar address={address} size={size === "md" ? "md" : "sm"} alt={text} />
      <span
        style={{
          color: C.dim,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {text}
      </span>
    </Link>
  );
}
