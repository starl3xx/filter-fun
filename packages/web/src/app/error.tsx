"use client";

/// Root error boundary for `/`. Next.js App Router convention: any error
/// thrown in the root segment (homepage component tree, including its hooks
/// and child components) bubbles up to this file.
///
/// Phase 1 audit C-5 (Phase 1 audit 2026-05-01): the homepage previously had
/// NO error boundary. A throw inside `useTokens()`, `useSeason()`, or any
/// child component crashed the tree silently — users saw a blank screen with
/// no recovery path. This boundary renders a recoverable error card so users
/// can retry without a full page reload.
///
/// `error.tsx` is paired with `app/global-error.tsx` (the framework-level
/// fallback when *this* boundary itself crashes). Genesis ships the
/// per-route boundary; `global-error.tsx` is intentionally not added because
/// Next ships a usable default and the surface here is small enough that
/// stacking another layer would be premature.

import {useEffect} from "react";

export default function HomeError({
  error,
  reset,
}: {
  error: Error & {digest?: string};
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console so a watching operator (or Sentry,
    // when wired) sees the original stack trace. Next masks the message
    // in production builds; the digest correlates to server-side logs.
    // eslint-disable-next-line no-console
    console.error("[homepage] uncaught render error:", error);
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
        ▼ Something broke in the arena
      </div>
      <p style={{margin: 0, fontSize: 14, color: "#aaa", maxWidth: 480, lineHeight: 1.5}}>
        We hit an unexpected error rendering this page. Your wallet and on-chain state are
        unaffected — try reloading the data, or refresh the page if it persists.
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
