/**
 * Average True Range (Wilder).
 *
 *   TR  = max(high-low, |high-prevClose|, |low-prevClose|)
 *   ATR = Wilder smoothed TR with initial seed = simple mean of first `period` TRs.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number[] {
  const n = closes.length;
  if (highs.length !== n || lows.length !== n) {
    throw new Error('atr: highs/lows/closes must have equal length');
  }
  const out: number[] = new Array(n).fill(NaN);
  if (n <= period) return out;

  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h = highs[i] as number;
    const l = lows[i] as number;
    const pc = closes[i - 1] as number;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i] as number;
  let prev = s / period;
  out[period] = prev;

  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + (tr[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}
