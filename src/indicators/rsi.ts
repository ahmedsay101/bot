/**
 * Wilder's RSI. Returns RSI[] aligned to closes (NaN for indices < period).
 *
 *   RS  = avgGain / avgLoss
 *   RSI = 100 - 100 / (1 + RS)
 *
 * Initial avgGain/avgLoss seeded from simple mean of first `period` deltas;
 * subsequent values smoothed with Wilder's recursion:
 *   avgGain_t = (avgGain_{t-1} * (n-1) + gain_t) / n
 */
export function rsi(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const c = closes[i] as number;
    const p = closes[i - 1] as number;
    const d = c - p;
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = computeRsi(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = computeRsi(avgGain, avgLoss);
  }
  return out;
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
