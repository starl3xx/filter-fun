// Tiny seeded PRNG — deterministic per-ticker sparklines so the initial layout
// is stable across renders before live ticks start.

function seeded(seedNum: number): () => number {
  let s = seedNum >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s >>>= 0;
    s ^= s << 5;
    s >>>= 0;
    return (s & 0xffffffff) / 0xffffffff;
  };
}

export function makeSparkline(ticker: string, points = 32, trend = 0): number[] {
  let seed = 0;
  for (let i = 0; i < ticker.length; i++) {
    seed = (seed * 31 + ticker.charCodeAt(i)) >>> 0;
  }
  const rng = seeded(seed);
  const out: number[] = [];
  let v = 0.5;
  for (let i = 0; i < points; i++) {
    v += (rng() - 0.5) * 0.18 + (trend / points) * 0.6;
    v = Math.max(0.05, Math.min(0.95, v));
    out.push(v);
  }
  return out;
}

export function sparkPath(values: number[], w: number, h: number, pad = 2): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1);
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) * (1 - (v - min) / range);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}
