"use client";

import {useMemo} from "react";

// Decorative twinkles. Memoized so they don't reseed on every parent re-render.
// Reduced-motion users get static stars (CSS handles the animation suppression).
export function Stars() {
  const stars = useMemo(
    () =>
      Array.from({length: 48}, () => ({
        x: Math.random() * 100,
        y: Math.random() * 100,
        s: Math.random() * 1.6 + 0.4,
        d: Math.random() * 3,
      })),
    [],
  );
  return (
    <div style={{position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0}}>
      {stars.map((s, i) => (
        <div
          key={i}
          className="ff-star"
          style={{
            position: "absolute",
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.s,
            height: s.s,
            background: "#fff",
            borderRadius: 99,
            opacity: 0.5,
            animationDelay: `${s.d}s`,
          }}
        />
      ))}
    </div>
  );
}
