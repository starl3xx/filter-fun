"use client";

/// Per-route error boundary for `/launch`. See `app/error.tsx` for the
/// rationale (audit finding C-5, Phase 1 audit 2026-05-01). The launch
/// page renders pre-transaction UI (slot grid, pricing, form) — a render
/// crash here previously left the user with a blank screen mid-launch flow,
/// with no path back other than navigating away. This boundary recovers
/// the page with a single click.

import {useEffect} from "react";

export default function LaunchError({
  error,
  reset,
}: {
  error: Error & {digest?: string};
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[launch] uncaught render error:", error);
  }, [error]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 24px",
        gap: 18,
        textAlign: "center",
        color: "#fff",
        background: "transparent",
      }}
    >
      <div style={{fontSize: 14, fontWeight: 700, letterSpacing: "0.16em", color: "#ff5577", textTransform: "uppercase"}}>
        ▼ Launch page hit an error
      </div>
      <p style={{margin: 0, fontSize: 14, color: "#aaa", maxWidth: 480, lineHeight: 1.5}}>
        We couldn't render the launch surface. No transaction was sent. Try reloading; if the
        problem persists, check your wallet/network connection or refresh the page.
      </p>
      {error.digest && (
        <code style={{fontSize: 11, color: "#666", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"}}>
          ref: {error.digest}
        </code>
      )}
      <button
        type="button"
        onClick={reset}
        style={{
          padding: "10px 18px",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.06em",
          color: "#fff",
          background: "#ff5577",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
          textTransform: "uppercase",
        }}
      >
        Reload
      </button>
    </div>
  );
}
