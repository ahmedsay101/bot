/**
 * Pure indicator helpers for the selective trend engine (no I/O).
 */
import type { Candle } from './trendCalc';

export function closedOnly(candles: Candle[]): Candle[] {
  return candles.filter((c) => c.isClosed);
}

export function toOHLCV(candles: Candle[]): {
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
} {
  return {
    opens: candles.map((c) => Number(c.open)),
    highs: candles.map((c) => Number(c.high)),
    lows: candles.map((c) => Number(c.low)),
    closes: candles.map((c) => Number(c.close)),
    volumes: candles.map((c) => Number(c.volume)),
  };
}

export function ema(values: number[], period: number): number[] {
  if (period < 1 || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  if (values.length < period) {
    out[0] = values[0]!;
    for (let i = 1; i < values.length; i++) {
      out[i] = (values[i]! - out[i - 1]!) * k + out[i - 1]!;
    }
    return out;
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  out[period - 1] = sum / period;
  for (let i = 0; i < period - 1; i++) out[i] = out[period - 1]!;
  for (let i = period; i < values.length; i++) {
    out[i] = (values[i]! - out[i - 1]!) * k + out[i - 1]!;
  }
  return out;
}

export function sma(values: number[], period: number): number {
  if (values.length < period || period < 1) return 0;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Wilder ATR last value. */
export function calcAtr(highs: number[], lows: number[], closes: number[], period: number): number {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (period < 1 || n < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    const high = highs[i]!;
    const low = lows[i]!;
    const prevClose = closes[i - 1]!;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (tr.length < period) return 0;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i]!;
  atr /= period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }
  return atr;
}

export interface AdxDi {
  adx: number;
  plusDi: number;
  minusDi: number;
  /** Rough ADX slope over last few DX points (positive = rising). */
  adxSlope: number;
}

export function calcAdxDi(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): AdxDi {
  const empty = { adx: 0, plusDi: 0, minusDi: 0, adxSlope: 0 };
  const n = Math.min(highs.length, lows.length, closes.length);
  if (period < 1 || n < period * 2) return empty;

  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < n; i++) {
    const high = highs[i]!;
    const low = lows[i]!;
    const prevHigh = highs[i - 1]!;
    const prevLow = lows[i - 1]!;
    const prevClose = closes[i - 1]!;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    const up = high - prevHigh;
    const down = prevLow - low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  if (tr.length < period * 2 - 1) return empty;

  let atr = 0;
  let sp = 0;
  let sm = 0;
  for (let i = 0; i < period; i++) {
    atr += tr[i]!;
    sp += plusDm[i]!;
    sm += minusDm[i]!;
  }

  const adxSeries: number[] = [];
  let lastPlus = 0;
  let lastMinus = 0;
  const push = (a: number, p: number, m: number): void => {
    if (a === 0) {
      adxSeries.push(0);
      return;
    }
    lastPlus = (100 * p) / a;
    lastMinus = (100 * m) / a;
    const den = lastPlus + lastMinus;
    adxSeries.push(den === 0 ? 0 : (100 * Math.abs(lastPlus - lastMinus)) / den);
  };
  push(atr, sp, sm);
  for (let i = period; i < tr.length; i++) {
    atr = atr - atr / period + tr[i]!;
    sp = sp - sp / period + plusDm[i]!;
    sm = sm - sm / period + minusDm[i]!;
    push(atr, sp, sm);
  }
  if (adxSeries.length < period) return empty;

  let adx = 0;
  for (let i = 0; i < period; i++) adx += adxSeries[i]!;
  adx /= period;
  const smoothed: number[] = [adx];
  for (let i = period; i < adxSeries.length; i++) {
    adx = (adx * (period - 1) + adxSeries[i]!) / period;
    smoothed.push(adx);
  }
  const len = smoothed.length;
  const slope = len >= 4 ? smoothed[len - 1]! - smoothed[len - 4]! : 0;
  return { adx, plusDi: lastPlus, minusDi: lastMinus, adxSlope: slope };
}

export function calcRoc(closes: number[], period: number): number {
  if (closes.length <= period) return 0;
  const curr = closes[closes.length - 1]!;
  const prev = closes[closes.length - 1 - period]!;
  if (prev === 0) return 0;
  return ((curr - prev) / prev) * 100;
}

/** Wilder RSI last value. */
export function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // one more smooth pass over remaining if long enough — simple last window is OK for selectivity
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdLast {
  macd: number;
  signal: number;
  histogram: number;
}

export function calcMacd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdLast {
  if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ef[i]! - es[i]!);
  }
  const sig = ema(macdLine, signalPeriod);
  const last = closes.length - 1;
  const macd = macdLine[last]!;
  const signal = sig[last]!;
  return { macd, signal, histogram: macd - signal };
}

/**
 * Kaufman's Efficiency Ratio over `period` bars:
 * |net change| / sum(|bar changes|)
 */
export function efficiencyRatio(closes: number[], period: number): number {
  if (closes.length <= period || period < 1) return 0;
  const end = closes.length - 1;
  const start = end - period;
  const net = Math.abs(closes[end]! - closes[start]!);
  let path = 0;
  for (let i = start + 1; i <= end; i++) {
    path += Math.abs(closes[i]! - closes[i - 1]!);
  }
  if (path === 0) return 0;
  return net / path;
}

export interface SwingPoint {
  index: number;
  price: number;
  kind: 'HIGH' | 'LOW';
}

/** Simple fractal swings: high/low vs `left`/`right` neighbors. */
export function detectSwings(
  highs: number[],
  lows: number[],
  left = 2,
  right = 2,
): SwingPoint[] {
  const out: SwingPoint[] = [];
  const n = Math.min(highs.length, lows.length);
  for (let i = left; i < n - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= left; j++) {
      if (highs[i]! <= highs[i - j]!) isHigh = false;
      if (lows[i]! >= lows[i - j]!) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (highs[i]! <= highs[i + j]!) isHigh = false;
      if (lows[i]! >= lows[i + j]!) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: highs[i]!, kind: 'HIGH' });
    if (isLow) out.push({ index: i, price: lows[i]!, kind: 'LOW' });
  }
  return out;
}

export type StructureBias = 'BULLISH' | 'BEARISH' | 'NONE';

/** Higher highs/higher lows vs lower highs/lower lows from recent swings. */
export function structureBias(swings: SwingPoint[], lookback = 6): StructureBias {
  const recent = swings.slice(-lookback);
  const highs = recent.filter((s) => s.kind === 'HIGH');
  const lows = recent.filter((s) => s.kind === 'LOW');
  if (highs.length < 2 || lows.length < 2) return 'NONE';
  const h1 = highs[highs.length - 2]!.price;
  const h2 = highs[highs.length - 1]!.price;
  const l1 = lows[lows.length - 2]!.price;
  const l2 = lows[lows.length - 1]!.price;
  if (h2 > h1 && l2 > l1) return 'BULLISH';
  if (h2 < h1 && l2 < l1) return 'BEARISH';
  return 'NONE';
}

/**
 * Windowed structure: compare recent vs prior half of lookback for HH/HL or LH/LL.
 * More robust than fractals alone on dense trending series.
 */
export function structureFromWindows(
  highs: number[],
  lows: number[],
  lookback = 24,
): StructureBias {
  if (highs.length < lookback * 2 || lows.length < lookback * 2) return 'NONE';
  const n = highs.length;
  const recentH = Math.max(...highs.slice(n - lookback));
  const prevH = Math.max(...highs.slice(n - lookback * 2, n - lookback));
  const recentL = Math.min(...lows.slice(n - lookback));
  const prevL = Math.min(...lows.slice(n - lookback * 2, n - lookback));
  if (recentH > prevH && recentL >= prevL) return 'BULLISH';
  if (recentH < prevH && recentL <= prevL) return 'BEARISH';
  return 'NONE';
}

/** Distance from last close to nearest prior swing high/low in ATR units. */
export function structureDistances(
  closes: number[],
  swings: SwingPoint[],
  atr: number,
): { toResistanceAtr: number; toSupportAtr: number } {
  const price = closes[closes.length - 1]!;
  if (atr <= 0) return { toResistanceAtr: 99, toSupportAtr: 99 };
  let res = Infinity;
  let sup = Infinity;
  for (const s of swings) {
    if (s.kind === 'HIGH' && s.price > price) {
      res = Math.min(res, (s.price - price) / atr);
    }
    if (s.kind === 'LOW' && s.price < price) {
      sup = Math.min(sup, (price - s.price) / atr);
    }
  }
  return {
    toResistanceAtr: Number.isFinite(res) ? res : 99,
    toSupportAtr: Number.isFinite(sup) ? sup : 99,
  };
}

/** False breakout: broke swing then closed back through within `window` bars. */
export function detectFalseBreakout(
  closes: number[],
  highs: number[],
  lows: number[],
  swings: SwingPoint[],
  window = 5,
): { falseBull: boolean; falseBear: boolean } {
  if (swings.length === 0 || closes.length < window + 2) {
    return { falseBull: false, falseBear: false };
  }
  const lastSwingHigh = [...swings].reverse().find((s) => s.kind === 'HIGH');
  const lastSwingLow = [...swings].reverse().find((s) => s.kind === 'LOW');
  let falseBull = false;
  let falseBear = false;
  const end = closes.length - 1;
  if (lastSwingHigh != null && lastSwingHigh.index < end - 1) {
    for (let i = Math.max(lastSwingHigh.index + 1, end - window); i <= end; i++) {
      if (highs[i]! > lastSwingHigh.price && closes[i]! < lastSwingHigh.price) {
        falseBull = true;
        break;
      }
    }
  }
  if (lastSwingLow != null && lastSwingLow.index < end - 1) {
    for (let i = Math.max(lastSwingLow.index + 1, end - window); i <= end; i++) {
      if (lows[i]! < lastSwingLow.price && closes[i]! > lastSwingLow.price) {
        falseBear = true;
        break;
      }
    }
  }
  return { falseBull, falseBear };
}

/** Normalized EMA slope: (ema[t]-ema[t-n]) / atr. */
export function emaSlopeAtr(emaSeries: number[], atr: number, lookback = 5): number {
  if (emaSeries.length <= lookback || atr <= 0) return 0;
  const last = emaSeries[emaSeries.length - 1]!;
  const prev = emaSeries[emaSeries.length - 1 - lookback]!;
  return (last - prev) / atr;
}
