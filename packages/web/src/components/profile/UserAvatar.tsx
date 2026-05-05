"use client";

/// User avatar — Epic 1.24 (spec §38).
///
/// Resolution chain:
///   1. ENS avatar (via wagmi's `useEnsAvatar`). Aggressively cached by
///      wagmi's React Query layer — repeated mounts at the same address pay
///      one network round-trip per session.
///   2. Deterministic identicon (hash-based geometric pattern) when ENS
///      misses or errors.
///
/// What we DON'T do:
///   - Gravatar — we don't collect emails. Spec §38 dispatch explicitly rules
///     this out.
///   - Loading spinner / delayed render — we render the identicon immediately
///     and swap to ENS when it resolves. The identicon is the always-correct
///     fallback so the page never shows an empty circle.
///
/// The identicon is generated inline (no @dicebear / external library) — a
/// 6×6 symmetric grid of cells colored from a hash of the address. Pure
/// math, no canvas, renders as inline SVG. Keeps bundle size flat and avoids
/// canvas/font sniffing the way library identicons sometimes do.

import {useContext, useMemo} from "react";
import {useEnsAvatar, useEnsName, WagmiContext} from "wagmi";
import {mainnet} from "wagmi/chains";

export type UserAvatarSize = "sm" | "md" | "lg" | "xl";

export type UserAvatarProps = {
  address: `0x${string}`;
  size?: UserAvatarSize;
  /// Override the alt text. Defaults to the address — pass a username when
  /// available so screen-readers announce it.
  alt?: string;
  className?: string;
};

const SIZE_PX: Record<UserAvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 96,
};

export function UserAvatar({address, size = "md", alt, className}: UserAvatarProps) {
  const px = SIZE_PX[size];
  const identicon = useMemo(() => generateIdenticon(address, px), [address, px]);

  // The avatar appears in test contexts (component-level tests for
  // ArenaTokenDetail, etc.) that don't wrap in a WagmiProvider. wagmi's
  // `useEnsName` throws synchronously when no provider is present — fatal
  // for those tests. Branch on the context instead so the identicon
  // fallback renders cleanly without ENS in non-wagmi mounts. In the real
  // app the Providers tree always wraps every page so this branch is
  // never taken in production.
  const wagmiCfg = useContext(WagmiContext);
  if (!wagmiCfg) {
    return renderIdenticon({px, identicon, alt: alt ?? address, className});
  }
  return (
    <UserAvatarWithEns
      address={address}
      px={px}
      identicon={identicon}
      alt={alt}
      className={className}
    />
  );
}

function UserAvatarWithEns({
  address,
  px,
  identicon,
  alt,
  className,
}: {
  address: `0x${string}`;
  px: number;
  identicon: ReturnType<typeof generateIdenticon>;
  alt?: string;
  className?: string;
}) {
  // ENS resolves on Ethereum mainnet regardless of the active chain; pin
  // chainId so a Base-deployed app still resolves the user's mainnet ENS.
  const {data: ensName} = useEnsName({address, chainId: mainnet.id});
  const {data: ensAvatarUrl} = useEnsAvatar({
    name: ensName ?? undefined,
    chainId: mainnet.id,
  });

  if (ensAvatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={ensAvatarUrl}
        alt={alt ?? ensName ?? address}
        width={px}
        height={px}
        className={className}
        style={{
          width: px,
          height: px,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }

  return renderIdenticon({px, identicon, alt: alt ?? ensName ?? address, className});
}

function renderIdenticon({
  px,
  identicon,
  alt,
  className,
}: {
  px: number;
  identicon: ReturnType<typeof generateIdenticon>;
  alt: string;
  className?: string;
}) {
  return (
    <div
      className={className}
      role="img"
      aria-label={alt}
      style={{
        width: px,
        height: px,
        flexShrink: 0,
        borderRadius: "50%",
        overflow: "hidden",
        background: identicon.background,
        display: "inline-block",
      }}
      dangerouslySetInnerHTML={{__html: identicon.svg}}
    />
  );
}

// ============================================================ identicon

/// 6×6 horizontally-symmetric grid identicon. Inspired by GitHub's identicon
/// shape but generated inline so we don't pull in another dep. The hash
/// drives:
///   - foreground HSL color (hue from first 2 bytes, fixed S/L for contrast)
///   - background HSL color (complement, lower saturation)
///   - cell fill bits (bytes 4..18 give us 28 bits — enough for the 18 cells
///     in the left half of a 6×6 grid).
///
/// Determinism: identical addresses produce identical identicons across
/// reloads. The SVG is plain — no fonts, no filters — so it renders crisp
/// at any size.
function generateIdenticon(address: string, px: number): {svg: string; background: string} {
  const hash = simpleHash(address.toLowerCase());
  const hue = hash[0] ?? 0;
  // Fixed sat/light tuned for legibility against either a light or dark
  // page background. Avoid pure white / pure black corners.
  const fg = `hsl(${(hue * 360) / 256}, 70%, 55%)`;
  const bg = `hsl(${(hue * 360) / 256}, 30%, 92%)`;

  const cellSize = px / 6;
  const cells: string[] = [];
  // Walk the left 3 columns of the 6×6 grid + mirror to the right 3.
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 3; col++) {
      const bitIndex = row * 3 + col;
      const byteIndex = (bitIndex % (hash.length - 1)) + 1; // skip byte 0 (used for hue)
      const filled = ((hash[byteIndex] ?? 0) & (1 << (bitIndex % 8))) !== 0;
      if (filled) {
        const x = col * cellSize;
        const y = row * cellSize;
        cells.push(
          `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${fg}"/>`,
        );
        // mirror to the right half (col 5 → 5-col)
        const mirrorX = (5 - col) * cellSize;
        cells.push(
          `<rect x="${mirrorX}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${fg}"/>`,
        );
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">${cells.join("")}</svg>`;
  return {svg, background: bg};
}

/// Tiny deterministic hash of a string into a Uint8Array. NOT cryptographic —
/// it just needs to spread bits well enough that two near-identical
/// addresses produce visually distinct identicons.
function simpleHash(s: string): Uint8Array {
  const out = new Uint8Array(20);
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Spread the 32-bit hash across 20 bytes by re-hashing each round.
  for (let i = 0; i < 20; i++) {
    h ^= i;
    h = Math.imul(h, 0x01000193);
    out[i] = (h >>> ((i % 4) * 8)) & 0xff;
  }
  return out;
}
