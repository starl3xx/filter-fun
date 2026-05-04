"use client";

/// `/p/[identifier]` — public profile page (Epic 1.24, spec §38).
///
/// `:identifier` is either a 0x-prefixed 40-char address OR a username. The
/// indexer's `/profile/:identifier` resolves both shapes server-side; the
/// client just hands it through. On username paths that don't resolve, the
/// indexer returns 404; on address paths it always returns 200 (per spec §22
/// — avoid leaking participation status via HTTP code), and the client gates
/// the empty state itself.
///
/// "Empty state" rule from the dispatch: a wallet's profile only exists if
///   (a) they've participated (at least one created token, or any stats), OR
///   (b) they've explicitly set a username.
/// Otherwise we render a 404 page even though the indexer returned 200.

import {useCallback, useEffect, useState} from "react";
import {useParams} from "next/navigation";
import Link from "next/link";
import {useAccount} from "wagmi";

import {C, F} from "@/lib/tokens";
import {fetchProfile, type ProfileResponse, type UserProfileBlock} from "@/lib/arena/api";

import {CreatedTokensList} from "@/components/profile/CreatedTokensList";
import {ProfileBadges} from "@/components/profile/ProfileBadges";
import {ProfileHeader} from "@/components/profile/ProfileHeader";
import {ProfileStats} from "@/components/profile/ProfileStats";
import {SetUsernameModal} from "@/components/profile/SetUsernameModal";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const USERNAME_RE = /^[a-zA-Z0-9-]{3,32}$/;

type FetchState =
  | {state: "loading"}
  | {state: "ready"; profile: ProfileResponse}
  | {state: "not-found"}
  | {state: "error"; message: string};

export default function ProfilePage() {
  const params = useParams<{identifier: string}>();
  const raw = params?.identifier ?? "";

  const isValidShape = ADDRESS_RE.test(raw) || USERNAME_RE.test(raw);
  if (!isValidShape) {
    return <NotFoundPage identifier={raw} />;
  }
  return <Profile identifier={raw} />;
}

function Profile({identifier}: {identifier: string}) {
  const [data, setData] = useState<FetchState>({state: "loading"});
  const [showModal, setShowModal] = useState(false);
  const {address: connectedAddress} = useAccount();

  useEffect(() => {
    let cancelled = false;
    fetchProfile(identifier)
      .then((profile) => {
        if (!cancelled) setData({state: "ready", profile});
      })
      .catch((err) => {
        if (cancelled) return;
        const status = errorStatus(err);
        if (status === 404) {
          setData({state: "not-found"});
          return;
        }
        setData({
          state: "error",
          message: err instanceof Error ? err.message : "Failed to load profile",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [identifier]);

  const onSuccess = useCallback(
    (newProfile: UserProfileBlock) => {
      // Optimistically merge the new userProfile block into the existing
      // ProfileResponse so the header rerenders without a full refetch. The
      // user sees their new handle immediately. We then kick a SILENT
      // background refresh — Bugbot M PR #102: the previous version called
      // a `refresh` helper that set `state: "loading"` on entry, which
      // immediately wiped the optimistic UI back to a loading spinner. The
      // silent refetch below merges the fresh response on success and
      // leaves the optimistic state visible the entire time.
      setData((prev) => {
        if (prev.state !== "ready") return prev;
        return {
          state: "ready",
          profile: {...prev.profile, userProfile: newProfile},
        };
      });
      setShowModal(false);
      void (async () => {
        try {
          const profile = await fetchProfile(identifier);
          setData((prev) => {
            // Only commit if we're still in `ready` AND the fetched response
            // includes the userProfile change. Otherwise keep the optimistic
            // merge — a stale read shouldn't roll the UI back to the old
            // username (e.g. read replica lag, indexer cache mid-invalidate).
            if (prev.state !== "ready") return prev;
            const fetchedHandle = profile.userProfile?.username ?? null;
            const optimisticHandle = prev.profile.userProfile?.username ?? null;
            if (fetchedHandle !== optimisticHandle && optimisticHandle !== null) {
              // Server hasn't caught up — keep optimistic state.
              return prev;
            }
            return {state: "ready", profile};
          });
        } catch {
          // Silent failure: the optimistic state is still on screen so the
          // user sees their new handle. The next page navigation will
          // re-fetch and reconcile.
        }
      })();
    },
    [identifier],
  );

  if (data.state === "loading") {
    return <ProfileShell><LoadingState /></ProfileShell>;
  }
  if (data.state === "not-found") {
    return <NotFoundPage identifier={identifier} />;
  }
  if (data.state === "error") {
    return (
      <ProfileShell>
        <div style={{color: C.red, padding: 32}}>Error: {data.message}</div>
      </ProfileShell>
    );
  }

  const {profile} = data;
  const userProfile: UserProfileBlock = profile.userProfile ?? {
    address: profile.address,
    username: null,
    usernameDisplay: null,
    hasUsername: false,
  };

  // Empty-state gate (per dispatch §38 #6 + "Don't auto-create profiles"):
  // 404 the page if (a) the user has no participation in the indexer AND
  // (b) they haven't explicitly set a username. Address-shaped identifiers
  // for never-active wallets fall through this gate.
  const hasParticipation =
    profile.createdTokens.length > 0 ||
    profile.stats.wins > 0 ||
    profile.stats.filtersSurvived > 0 ||
    profile.stats.tokensTraded > 0 ||
    BigInt(profile.stats.lifetimeTradeVolumeWei || "0") > 0n ||
    BigInt(profile.stats.rolloverEarnedWei || "0") > 0n ||
    BigInt(profile.stats.bonusEarnedWei || "0") > 0n ||
    profile.badges.length > 0;
  if (!hasParticipation && !userProfile.hasUsername) {
    return <NotFoundPage identifier={identifier} />;
  }

  const connectedAddr = (connectedAddress ?? null) as `0x${string}` | null;

  return (
    <ProfileShell>
      <ProfileHeader
        address={profile.address}
        userProfile={userProfile}
        connectedAddress={connectedAddr}
        onOpenSetUsername={() => setShowModal(true)}
      />
      <Section title="Stats">
        <ProfileStats stats={profile.stats} />
      </Section>
      <Section title="Badges">
        <ProfileBadges badges={profile.badges} />
      </Section>
      <Section title="Tokens created">
        <CreatedTokensList tokens={profile.createdTokens} />
      </Section>
      {showModal ? (
        <SetUsernameModal
          address={profile.address}
          initial={userProfile}
          onClose={() => setShowModal(false)}
          onSuccess={onSuccess}
        />
      ) : null}
    </ProfileShell>
  );
}

function ProfileShell({children}: {children: React.ReactNode}) {
  return (
    <main
      className="ff-profile-page"
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: "32px 24px 64px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <BackToArena />
      {children}
    </main>
  );
}

function BackToArena() {
  return (
    <Link
      href="/"
      style={{
        fontSize: 12,
        color: C.dim,
        textDecoration: "none",
        letterSpacing: "0.04em",
        fontFamily: F.mono,
      }}
    >
      ← arena
    </Link>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 10}}>
      <div
        style={{
          fontSize: 11,
          color: C.dim,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      style={{
        padding: "48px 0",
        color: C.dim,
        fontSize: 14,
        fontFamily: F.mono,
      }}
    >
      Loading profile…
    </div>
  );
}

function NotFoundPage({identifier}: {identifier: string}) {
  return (
    <main
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "96px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 800,
          fontFamily: F.display,
          color: C.text,
          marginBottom: 16,
        }}
      >
        ▼
      </div>
      <div
        style={{
          fontSize: 18,
          color: C.text,
          marginBottom: 8,
          fontFamily: F.display,
          fontWeight: 700,
        }}
      >
        No profile here
      </div>
      <div style={{fontSize: 13, color: C.dim, marginBottom: 24, wordBreak: "break-word"}}>
        Nothing matches{" "}
        <code style={{fontFamily: F.mono, color: C.text}}>{identifier}</code>.
      </div>
      <Link
        href="/"
        style={{
          color: C.pink,
          textDecoration: "none",
          fontSize: 13,
          fontFamily: F.display,
          fontWeight: 700,
          letterSpacing: "0.04em",
        }}
      >
        ← Back to the arena
      </Link>
    </main>
  );
}

/// `fetchProfile` rejects on non-2xx; the underlying `fetchJson` typically
/// throws an Error whose message includes the status. We probe heuristically
/// for the 404 case so the page can branch.
function errorStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/\b(\d{3})\b/);
  return m ? Number(m[1]) : null;
}
