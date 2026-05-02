/** Round half-away-from-zero to N decimals. */
export function round(value: number, decimals = 8): number {
  const f = 10 ** decimals;
  return Math.sign(value) * Math.round(Math.abs(value) * f) / f;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Quantize value to the nearest multiple of step (toward zero). */
export function quantize(value: number, step: number): number {
  if (step <= 0) return value;
  const decimals = stepDecimals(step);
  return round(Math.floor(value / step) * step, decimals);
}

export function stepDecimals(step: number): number {
  if (step >= 1) return 0;
  const s = step.toExponential();
  const m = /e-(\d+)/.exec(s);
  return m && m[1] ? parseInt(m[1], 10) : 8;
}

/** Mulberry32 — small fast deterministic PRNG. */
export function createRng(seed?: string | number): () => number {
  let h: number;
  if (typeof seed === 'string') {
    h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) | 0;
    }
  } else if (typeof seed === 'number') {
    h = seed | 0;
  } else {
    h = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) | 0;
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInRange(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
