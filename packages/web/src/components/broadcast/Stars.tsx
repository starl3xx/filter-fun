"use client";

import {useEffect, useState} from "react";

type Star = {x: number; y: number; s: number; d: number};

// Decorative twinkles. Generated client-side only — Math.random() in render
// would cause hydration mismatch (server HTML has different positions than the
// client first render). Server emits an empty container; client fills it after
// mount. The twinkle CSS animation handles the rest.
export function Stars() {
  const [stars, setStars] = useState<Star[]>([]);
  useEffect(() => {
    setStars(
      Array.from({length: 48}, () => ({
        x: Math.random() * 100,
        y: Math.random() * 100,
        s: Math.random() * 1.6 + 0.4,
        d: Math.random() * 3,
      })),
    );
  }, []);

  return (
    <div style={{position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0}} aria-hidden>
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
