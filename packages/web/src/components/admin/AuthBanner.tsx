"use client";

import type {Address} from "viem";

import {C, F} from "@/lib/tokens";
import {shortAddr} from "@/lib/token/format";
import type {AdminAuthState} from "@/hooks/token/useAdminAuth";

/// Top-of-page banner that surfaces the four auth states. Distinct from the
/// per-form CTAs (which gate individual actions) — this is the global "what
/// can I do here?" signal that frames the page.

export type AuthBannerProps = {
  state: AdminAuthState;
  admin: Address | null;
  pendingAdmin: Address | null;
  onConnect?: () => void;
  /// Surfaced only in the PENDING state. The actual `acceptAdmin` button lives
  /// in the right-column action panel; this prop is the cross-link.
  onScrollToAccept?: () => void;
};

export function AuthBanner({state, admin, pendingAdmin, onConnect, onScrollToAccept}: AuthBannerProps) {
  if (state === "ADMIN") {
    return (
      <Banner color={C.green} icon="✓">
        <strong>You are the admin of this token.</strong> Updates flow on-chain in two clicks
        (sign → confirm). Two-step admin transfer is mandatory — see the right column.
      </Banner>
    );
  }
  if (state === "PENDING") {
    return (
      <Banner color={C.yellow} icon="✦">
        <strong>You've been nominated as the new admin.</strong>{" "}
        Accept the role to take control. Until you do, the current admin
        ({admin ? shortAddr(admin) : "unknown"}) retains full control.
        {onScrollToAccept && (
          <>
            {" "}
            <button
              type="button"
              onClick={onScrollToAccept}
              style={{
                background: "transparent",
                border: "none",
                color: C.yellow,
                textDecoration: "underline",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: F.display,
                padding: 0,
              }}
            >
              Jump to accept
            </button>
          </>
        )}
      </Banner>
    );
  }
  if (state === "READ_ONLY") {
    return (
      <Banner color={C.faint} icon="○">
        <strong>Read-only.</strong> Connected wallet is not the admin of this token.
        Current admin: <code style={{fontFamily: F.mono}}>{admin ? shortAddr(admin) : "unknown"}</code>.
        {pendingAdmin && (
          <>
            {" "}
            Pending admin: <code style={{fontFamily: F.mono}}>{shortAddr(pendingAdmin)}</code>.
          </>
        )}
      </Banner>
    );
  }
  // DISCONNECTED
  return (
    <Banner color={C.cyan} icon="↗">
      <strong>Connect a wallet to manage this token.</strong> The admin console reads on-chain
      state without a connection; admin actions need a wallet matching the registered admin.
      {onConnect && (
        <>
          {" "}
          <button
            type="button"
            onClick={onConnect}
            style={{
              background: "transparent",
              border: "none",
              color: C.cyan,
              textDecoration: "underline",
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: F.display,
              padding: 0,
            }}
          >
            Connect now
          </button>
        </>
      )}
    </Banner>
  );
}

function Banner({color, icon, children}: {color: string; icon: string; children: React.ReactNode}) {
  return (
    <div
      role="status"
      data-banner-state="active"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "12px 16px",
        marginBottom: 16,
        borderRadius: 12,
        background: `${color}10`,
        border: `1px solid ${color}55`,
        color: C.text,
        fontFamily: F.display,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          display: "grid",
          placeItems: "center",
          borderRadius: 99,
          background: `${color}33`,
          color,
          fontWeight: 800,
          fontSize: 12,
        }}
      >
        {icon}
      </span>
      <span>{children}</span>
    </div>
  );
}
