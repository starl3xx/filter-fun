"use client";

/// Brand ▼ glyph — pink → red gradient SVG (spec §32.4).
///
/// Used everywhere the marketing surface previously used 🔻. The launch
/// page is the first surface to commit to the SVG mark; over time the
/// arena page can migrate from the emoji form too.

import {useId} from "react";

export function Triangle({size = 16, inline = false}: {size?: number; inline?: boolean}) {
  // U+25BC BLACK DOWN-POINTING TRIANGLE — visually closer to the brand
  // glyph than the heavy emoji 🔻. Each instance gets a unique gradient
  // id via React's `useId()` so multiple Triangles on one page (the
  // launch page renders a few — hero, filter strip, claim form, ack
  // checkbox) don't share a DOM id and steal each other's fill on
  // unmount.
  const id = `ff-tri-${useId()}`;
  return (
    <svg
      role="img"
      aria-label="filter"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{display: inline ? "inline-block" : "block", verticalAlign: inline ? "-0.18em" : undefined}}
    >
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ff5fb8" />
          <stop offset="100%" stopColor="#ff2d55" />
        </linearGradient>
      </defs>
      <path d="M2 4 L14 4 L8 14 Z" fill={`url(#${id})`} />
    </svg>
  );
}
