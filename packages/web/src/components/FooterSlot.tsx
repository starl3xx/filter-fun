"use client";

/// Pathname-gated footer slot — Epic 1.28.
///
/// Mounted once at the layout level. Reads the current route via
/// `usePathname` and renders `<FooterCanonical>` only on user-facing
/// surfaces. Operator console (`/operator`) and creator admin
/// (`/token/[address]/admin`) get a clean tail with no canonical
/// channel block — those are focused workflow surfaces.
///
/// Allowlist over denylist: the footer is positive-opt-in so a future
/// page added under a new top-level segment doesn't accidentally inherit
/// the channels block before product review.

import {usePathname} from "next/navigation";

import {FooterCanonical} from "./FooterCanonical";

/// Pathname prefixes that should render the footer. Each entry is
/// a top-level segment ("/", "/launch", …); deeper routes inherit
/// because the match is prefix-based.
const SHOW_ON_PREFIXES: ReadonlyArray<string> = [
  "/",
  "/launch",
  "/graveyard",
  "/winners",
  "/w/",
  "/p/",
];

/// Pathname prefixes that EXPLICITLY skip the footer even when the
/// allowlist would otherwise match. Used for focused workflow surfaces
/// (operator + creator admin). Routes under `/token/[address]/admin`
/// match `/token/` here — `/token` itself isn't a public route.
const HIDE_ON_PREFIXES: ReadonlyArray<string> = [
  "/operator",
  "/token/",
];

export function FooterSlot() {
  const pathname = usePathname();
  if (!pathname) return null;
  if (HIDE_ON_PREFIXES.some((p) => pathname.startsWith(p))) return null;
  const show = SHOW_ON_PREFIXES.some((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p)));
  if (!show) return null;
  return <FooterCanonical />;
}
