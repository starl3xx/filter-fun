"use client";

/// Profile header — Epic 1.24 (spec §38). Avatar + handle/address + copy
/// button. The "Set username" CTA only shows when the connected wallet
/// equals the profile address (case-insensitive).

import {useState} from "react";

import {C, F} from "@/lib/tokens";
import {addrEq, shortAddr} from "@/lib/token/format";

import type {UserProfileBlock} from "@/lib/arena/api";

import {UserAvatar} from "./UserAvatar";

export type ProfileHeaderProps = {
  address: `0x${string}`;
  userProfile: UserProfileBlock;
  /// Connected wallet (or null if no wallet connected).
  connectedAddress: `0x${string}` | null;
  /// Caller-supplied: when the wallet is the profile owner and clicks
  /// "Set username", we open the modal in the parent. The header itself
  /// doesn't own the modal state.
  onOpenSetUsername: () => void;
};

export function ProfileHeader({
  address,
  userProfile,
  connectedAddress,
  onOpenSetUsername,
}: ProfileHeaderProps) {
  const [copied, setCopied] = useState(false);
  const isSelf = addrEq(connectedAddress, address);

  const handleDisplay =
    userProfile.usernameDisplay ?? userProfile.username ?? null;

  function copyAddress() {
    navigator.clipboard.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
        // Clipboard API can fail in secure-context-less environments — silent
        // no-op; the user can still select the address text manually.
      },
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "20px 0",
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <UserAvatar address={address} size="xl" alt={handleDisplay ?? address} />
      <div style={{display: "flex", flexDirection: "column", gap: 6, minWidth: 0}}>
        <div
          style={{
            fontSize: 28,
            fontWeight: 800,
            fontFamily: F.display,
            letterSpacing: "-0.02em",
            color: C.text,
            wordBreak: "break-word",
          }}
        >
          {handleDisplay ?? shortAddr(address)}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <code
            style={{
              fontFamily: F.mono,
              fontSize: 12,
              color: C.dim,
              wordBreak: "break-all",
            }}
          >
            {address}
          </code>
          <button
            type="button"
            onClick={copyAddress}
            aria-label="Copy address"
            style={{
              padding: "2px 8px",
              borderRadius: 6,
              fontFamily: F.mono,
              fontSize: 11,
              background: "transparent",
              border: `1px solid ${C.line}`,
              color: copied ? C.green : C.dim,
              cursor: "pointer",
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {isSelf ? (
            <button
              type="button"
              onClick={onOpenSetUsername}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                fontFamily: F.display,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                background: `${C.pink}22`,
                border: `1px solid ${C.pink}66`,
                color: C.pink,
                cursor: "pointer",
              }}
            >
              {userProfile.hasUsername ? "Change username" : "Set username"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
