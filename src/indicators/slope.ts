/**
 * Per-spec slope: relative change of the MA between consecutive bars.
 *   slope_i = (MA_i - MA_{i-1}) / MA_{i-1}
 */
export function slope(ma: number[]): number[] {
  const n = ma.length;
  const out: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const a = ma[i - 1];
    const b = ma[i];
    if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b) || a === 0) continue;
    out[i] = (b - a) / a;
  }
  return out;
}

/**
 * Linear-regression slope of the last `lookback` values, expressed as
 * fractional change per bar relative to the mean. More stable than single-bar
 * delta.
 */
export function linearRegressionSlope(values: number[], lookback: number): number {
  const n = values.length;
  if (n < lookback || lookback < 2) return NaN;
  const start = n - lookback;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < lookback; i++) {
    const x = i;
    const y = values[start + i] as number;
    if (Number.isNaN(y)) return NaN;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const meanY = sumY / lookback;
  const denom = lookback * sumXX - sumX * sumX;
  if (denom === 0 || meanY === 0) return NaN;
  const slopeAbs = (lookback * sumXY - sumX * sumY) / denom;
  return slopeAbs / meanY;
}
