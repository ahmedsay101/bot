/** Simple Moving Average. NaN for indices < period - 1. */
export function sma(values: number[], period: number): number[] {
  const n = values.length;
  const out: number[] = new Array(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  let s = 0;
  for (let i = 0; i < period; i++) s += values[i] as number;
  out[period - 1] = s / period;
  for (let i = period; i < n; i++) {
    s += (values[i] as number) - (values[i - period] as number);
    out[i] = s / period;
  }
  return out;
}

/** Exponential Moving Average. Seeded with SMA over first `period`. */
export function ema(values: number[], period: number): number[] {
  const n = values.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += values[i] as number;
  let prev = s / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
