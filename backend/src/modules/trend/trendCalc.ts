/**
 * Multi-signal trend detection — pure math (no I/O).
 * Signals: EMA, price vs EMA, ADX, +DI/−DI, ROC momentum, volume.
 */

export interface Candle {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  /** true if candle is still forming — must be excluded from indicators */
  isClosed: boolean;
}

export type TrendStrength = 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE';
export type TrendStatus =
  | 'NOT_ANALYZED'
  | 'ANALYZING'
  | 'STRONG_CONFIRMED'
  | 'MODERATE'
  | 'WEAK'
  | 'NO_TREND'
  | 'ERROR';

/** Per-timeframe signal flags (legacy 5-signal shape kept for single-TF eval). */
export interface TrendSignals {
  emaAlignment: boolean;
  priceVsEma: boolean;
  adxStrong: boolean;
  diConfirms: boolean;
  momentumOk: boolean;
  volumeConfirmed: boolean;
}

export interface AdxDiResult {
  adx: number;
  plusDi: number;
  minusDi: number;
}

export interface TrendResult {
  direction: 'NONE' | 'BULLISH' | 'BEARISH';
  confirmed: boolean;
  score: number;
  requiredScore: number;
  strength: TrendStrength;
  signals: TrendSignals;
  adx: number;
  plusDi: number;
  minusDi: number;
}

export interface TrendCalcConfig {
  emaFast: number;
  emaSlow: number;
  adxPeriod: number;
  /** ADX >= this contributes adxStrong (default 25). */
  minAdx: number;
  /** ADX >= this is preferred for STRONG classification (default 30). */
  strongAdx: number;
  rocPeriod: number;
  momentumThreshold: number;
  volumeLookback: number;
  volumeMultiplier: number;
  /** Single-TF min score (legacy / sub-eval). */
  minScore: number;
}

export const DEFAULT_TREND_CALC_CONFIG: TrendCalcConfig = {
  emaFast: 20,
  emaSlow: 50,
  adxPeriod: 14,
  minAdx: 25,
  strongAdx: 30,
  rocPeriod: 10,
  momentumThreshold: 0.5,
  volumeLookback: 20,
  volumeMultiplier: 1.2,
  minScore: 4,
};

const FALSE_SIGNALS: TrendSignals = {
  emaAlignment: false,
  priceVsEma: false,
  adxStrong: false,
  diConfirms: false,
  momentumOk: false,
  volumeConfirmed: false,
};

function noneResult(requiredScore: number): TrendResult {
  return {
    direction: 'NONE',
    confirmed: false,
    score: 0,
    requiredScore,
    strength: 'NONE',
    signals: { ...FALSE_SIGNALS },
    adx: 0,
    plusDi: 0,
    minusDi: 0,
  };
}

export function strengthFromScore(
  score: number,
  maxScore: number,
  strongMin: number,
): TrendStrength {
  if (score >= strongMin) return 'STRONG';
  if (score >= Math.max(1, strongMin - 1)) return 'MODERATE';
  if (score >= Math.max(1, strongMin - 2)) return 'WEAK';
  if (score <= 0) return 'NONE';
  return 'WEAK';
}

export function statusFromStrength(strength: TrendStrength, error = false): TrendStatus {
  if (error) return 'ERROR';
  if (strength === 'STRONG') return 'STRONG_CONFIRMED';
  if (strength === 'MODERATE') return 'MODERATE';
  if (strength === 'WEAK') return 'WEAK';
  return 'NO_TREND';
}

/** Standard EMA; seeds with SMA of the first `period` values when enough data. */
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

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Last ROC %: ((close - close[n ago]) / close[n ago]) * 100 */
export function calcRoc(closes: number[], period: number): number {
  if (period < 1 || closes.length <= period) return 0;
  const curr = closes[closes.length - 1]!;
  const prev = closes[closes.length - 1 - period]!;
  if (prev === 0) return 0;
  return ((curr - prev) / prev) * 100;
}

/**
 * Wilder ADX with +DI / −DI.
 * Needs roughly 2 * period bars before a meaningful ADX exists.
 */
export function calcAdxDi(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): AdxDiResult {
  const empty = { adx: 0, plusDi: 0, minusDi: 0 };
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

    const highLow = high - low;
    const highClose = Math.abs(high - prevClose);
    const lowClose = Math.abs(low - prevClose);
    tr.push(Math.max(highLow, highClose, lowClose));

    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  if (tr.length < period * 2 - 1) return empty;

  let atr = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let i = 0; i < period; i++) {
    atr += tr[i]!;
    smoothPlus += plusDm[i]!;
    smoothMinus += minusDm[i]!;
  }

  const dxValues: number[] = [];
  let lastPlusDi = 0;
  let lastMinusDi = 0;

  const pushDx = (sp: number, sm: number, a: number): void => {
    if (a === 0) {
      dxValues.push(0);
      return;
    }
    const plusDi = (100 * sp) / a;
    const minusDi = (100 * sm) / a;
    lastPlusDi = plusDi;
    lastMinusDi = minusDi;
    const den = plusDi + minusDi;
    dxValues.push(den === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / den);
  };

  pushDx(smoothPlus, smoothMinus, atr);

  for (let i = period; i < tr.length; i++) {
    atr = atr - atr / period + tr[i]!;
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[i]!;
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[i]!;
    pushDx(smoothPlus, smoothMinus, atr);
  }

  if (dxValues.length < period) return empty;

  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxValues[i]!;
  adx /= period;

  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]!) / period;
  }
  return { adx, plusDi: lastPlusDi, minusDi: lastMinusDi };
}

/** @deprecated prefer calcAdxDi — returns ADX only */
export function calcAdx(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number {
  return calcAdxDi(highs, lows, closes, period).adx;
}

function minBarsNeeded(cfg: TrendCalcConfig): number {
  return Math.max(cfg.emaSlow, cfg.adxPeriod * 2 + 1, cfg.rocPeriod + 1, cfg.volumeLookback + 1);
}

function scoreSignals(s: TrendSignals): number {
  let n = 0;
  if (s.emaAlignment) n++;
  if (s.priceVsEma) n++;
  if (s.adxStrong) n++;
  if (s.diConfirms) n++;
  if (s.momentumOk) n++;
  if (s.volumeConfirmed) n++;
  return n;
}

/** Evaluate a single timeframe (closed candles only). */
export function evaluateTrendFromCandles(candles: Candle[], cfg: TrendCalcConfig): TrendResult {
  const closed = candles.filter((c) => c.isClosed);
  const required = minBarsNeeded(cfg);
  if (closed.length < required) {
    return noneResult(cfg.minScore);
  }

  const closes = closed.map((c) => Number(c.close));
  const highs = closed.map((c) => Number(c.high));
  const lows = closed.map((c) => Number(c.low));
  const volumes = closed.map((c) => Number(c.volume));

  const emaFastSeries = ema(closes, cfg.emaFast);
  const emaSlowSeries = ema(closes, cfg.emaSlow);
  const last = closes.length - 1;
  const price = closes[last]!;
  const emaFastVal = emaFastSeries[last]!;
  const emaSlowVal = emaSlowSeries[last]!;
  const { adx, plusDi, minusDi } = calcAdxDi(highs, lows, closes, cfg.adxPeriod);
  const roc = calcRoc(closes, cfg.rocPeriod);

  const volLookback = volumes.slice(Math.max(0, last - cfg.volumeLookback), last);
  const avgVol = average(volLookback.length > 0 ? volLookback : volumes.slice(0, last));
  const lastVol = volumes[last]!;
  const volumeConfirmed = avgVol > 0 && lastVol >= avgVol * cfg.volumeMultiplier;

  const bullishAligned = emaFastVal > emaSlowVal;
  const bearishAligned = emaFastVal < emaSlowVal;

  if (!bullishAligned && !bearishAligned) {
    return noneResult(cfg.minScore);
  }

  const direction: 'BULLISH' | 'BEARISH' = bullishAligned ? 'BULLISH' : 'BEARISH';

  const signals: TrendSignals =
    direction === 'BULLISH'
      ? {
          emaAlignment: true,
          priceVsEma: price > emaFastVal && price > emaSlowVal,
          adxStrong: adx >= cfg.minAdx,
          diConfirms: plusDi > minusDi,
          momentumOk: roc > cfg.momentumThreshold,
          volumeConfirmed,
        }
      : {
          emaAlignment: true,
          priceVsEma: price < emaFastVal && price < emaSlowVal,
          adxStrong: adx >= cfg.minAdx,
          diConfirms: minusDi > plusDi,
          momentumOk: roc < -cfg.momentumThreshold,
          volumeConfirmed,
        };

  const score = scoreSignals(signals);
  const strength = strengthFromScore(score, 6, Math.min(6, cfg.minScore + 2));
  // Single-TF "confirmed" = enough signals for that TF; multi-TF gate uses strength===STRONG.
  const confirmed = score >= cfg.minScore;

  return {
    direction,
    confirmed,
    score,
    requiredScore: cfg.minScore,
    strength,
    signals,
    adx,
    plusDi,
    minusDi,
  };
}
