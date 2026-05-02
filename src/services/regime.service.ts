import { Regime } from '../core/constants.js';
import { CONFIG } from '../core/config.js';
import { atr, sma, slope as slopeOf } from '../indicators/index.js';
import type { Candle } from './marketData.service.js';
import { mean } from '../utils/math.js';

export interface RegimeSnapshot {
  regime: Regime;
  slope: number;
  atr: number;
  atrRatio: number;
  ma: number;
}

/**
 * Detect market regime from a candle window.
 *
 * Simplified per audit: slope-only classification (atrRatio kept in the
 * snapshot for diagnostics but no longer required for RANGE).
 *
 *   RANGE   ⇔ |slope| < trendSlope
 *   TREND   ⇔ |slope| >= trendSlope
 *   UNKNOWN ⇔ insufficient data / non-finite indicators
 */
export function detectRegime(candles: Candle[]): RegimeSnapshot {
  const cfg = CONFIG();
  const need = Math.max(cfg.indicators.maPeriod, cfg.indicators.atrPeriod) + 30;
  if (candles.length < need) {
    return { regime: Regime.UNKNOWN, slope: NaN, atr: NaN, atrRatio: NaN, ma: NaN };
  }
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const atrSeries = atr(highs, lows, closes, cfg.indicators.atrPeriod);
  const maSeries = sma(closes, cfg.indicators.maPeriod);
  const slopeSeries = slopeOf(maSeries);

  const i = candles.length - 1;
  const atrNow = atrSeries[i] as number;
  const slopeNow = slopeSeries[i] as number;
  const maNow = maSeries[i] as number;

  const atrLookback = atrSeries.slice(Math.max(0, i - 30), i).filter((v) => Number.isFinite(v));
  const atrMean = atrLookback.length ? mean(atrLookback) : NaN;
  const atrRatio = atrMean > 0 ? atrNow / atrMean : NaN;

  if (!Number.isFinite(slopeNow)) {
    return { regime: Regime.UNKNOWN, slope: slopeNow, atr: atrNow, atrRatio, ma: maNow };
  }

  const isRange = Math.abs(slopeNow) < cfg.thresholds.trendSlope;
  return {
    regime: isRange ? Regime.RANGE : Regime.TREND,
    slope: slopeNow,
    atr: atrNow,
    atrRatio,
    ma: maNow,
  };
}
