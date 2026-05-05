/// Empty-state gate (per dispatch §38 #6 + "Don't auto-create profiles"):
/// 404 the page if (a) the user has no participation in the indexer AND
/// (b) they haven't explicitly set a username. Address-shaped identifiers
/// for never-active wallets fall through this gate.
///
/// Bugbot L PR #102 pass-19: distinguish "identity layer answered, user
/// has no username" from "identity layer was unreachable so we don't
/// know." The indexer (PR #102 pass-12) omits the `userProfile` field
/// entirely in the second case; when the field IS present, even with
/// `hasUsername: false`, the answer is authoritative. The previous
/// fallback collapsed both cases and 404'd users with a real username
/// during a transient indexer DB blip just because they happened to
/// have no on-chain participation yet. We now apply the gate ONLY when
/// `userProfile` was returned — otherwise we render with whatever data
/// we have rather than fail-closed to 404.
///
/// PR #102 pass-20: this lives in a sibling module rather than the page
/// itself because Next.js disallows non-default exports beyond a fixed
/// allowlist (`metadata`, `generateMetadata`, etc.) from page files,
/// and CI failed the build when this helper was inlined and exported
/// from `page.tsx`. The helper is pure, so colocating it as a peer of
/// `page.tsx` keeps it discoverable while satisfying the App Router's
/// constraint.

import type {ProfileResponse} from "@/lib/arena/api";

export function shouldShowEmptyState(profile: ProfileResponse): boolean {
  const hasParticipation =
    profile.createdTokens.length > 0 ||
    profile.stats.wins > 0 ||
    profile.stats.filtersSurvived > 0 ||
    profile.stats.tokensTraded > 0 ||
    BigInt(profile.stats.lifetimeTradeVolumeWei || "0") > 0n ||
    BigInt(profile.stats.rolloverEarnedWei || "0") > 0n ||
    BigInt(profile.stats.bonusEarnedWei || "0") > 0n ||
    profile.badges.length > 0;
  if (profile.userProfile === undefined) {
    // Identity layer was down on this fetch — we don't know whether
    // the user has a username, so don't fail-closed to 404. Defer to
    // participation alone; if there's any participation, render. If
    // there's no participation, also render — better to show an empty
    // profile than to mistakenly deny a user with a handle.
    return false;
  }
  return !hasParticipation && !profile.userProfile.hasUsername;
}
