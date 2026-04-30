/// Seedable pseudo-random number generator. The harness must produce
/// byte-identical output for a given seed (Track E will diff thousands of
/// historical replays against expected baselines), so any randomness in a
/// scenario — wallet selection, buy-amount jitter, retention churn —
/// flows through this PRNG rather than `Math.random()`.
///
/// `mulberry32` is a 32-bit LCG-ish generator with a 2^32 period and
/// excellent statistical properties for non-cryptographic simulation. It is
/// the standard "small + good" choice for deterministic JS sims.

export type Prng = () => number;

/// Returns a function that yields a uniform `[0, 1)` float on each call.
/// Identical seeds produce identical sequences across machines and Node
/// versions.
export function mulberry32(seed: number): Prng {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/// Convenience: integer in `[lo, hi]` inclusive, drawn from the PRNG.
export function randInt(prng: Prng, lo: number, hi: number): number {
  return lo + Math.floor(prng() * (hi - lo + 1));
}

/// Convenience: pick one element of an array uniformly at random.
export function pick<T>(prng: Prng, arr: ReadonlyArray<T>): T {
  if (arr.length === 0) throw new Error("pick: empty array");
  const v = arr[Math.floor(prng() * arr.length)];
  if (v === undefined) throw new Error("pick: undefined element"); // satisfies noUncheckedIndexedAccess
  return v;
}
