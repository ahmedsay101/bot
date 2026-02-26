/**
 * indicators.js – Pure indicator utility functions for regime detection.
 *
 * All functions are stateless and accept their parameters explicitly.
 * No magic numbers: every threshold comes from the caller.
 */

/**
 * Calculate Average True Range (ATR) for a series of candles.
 *
 * True Range for each candle = max(
 *   high - low,
 *   |high - prevClose|,
 *   |low  - prevClose|
 * )
 *
 * ATR is the simple moving average of True Range over `period` bars.
 *
 * @param {Array<{open:number,high:number,low:number,close:number}>} candles
 * @param {number} period – lookback window (e.g. 14)
 * @returns {number[]} Array of ATR values (length = candles.length - 1).
 *                     Index 0 corresponds to candle index 1.
 */
function calculateATR(candles, period) {
  if (!candles || candles.length < 2) return [];

  // Build True Range array (starts at index 1 since we need prev close)
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i - 1].close);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // Compute rolling SMA-based ATR values
  const atrValues = [];
  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period - 1) {
      // Not enough bars yet – push NaN placeholder
      atrValues.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += trueRanges[j];
    }
    atrValues.push(sum / period);
  }

  return atrValues;
}

/**
 * Measure the slope (rate of change) of ATR values over a lookback window.
 *
 * slope = (lastATR - atr[lookbackAgo]) / atr[lookbackAgo]
 *
 * Positive → volatility expanding.  Negative → compressing.
 *
 * @param {number[]} atrValues – array returned by calculateATR
 * @param {number}   lookback  – how many bars back to compare
 * @returns {number|null} Normalised slope, or null if insufficient data.
 */
function calculateATRSlope(atrValues, lookback) {
  // Filter to only valid (non-NaN) values
  const valid = atrValues.filter((v) => Number.isFinite(v));
  if (valid.length < lookback + 1) return null;

  const recent = valid[valid.length - 1];
  const past = valid[valid.length - 1 - lookback];
  if (!past || past === 0) return null;

  return (recent - past) / past;
}

/**
 * Measure whether the recent candle ranges are expanding or compressing
 * relative to a longer baseline.
 *
 * shortAvgRange / longAvgRange  → ratio > 1 means expansion.
 *
 * @param {Array<{high:number,low:number}>} candles
 * @param {number} shortPeriod – recent window (e.g. 6)
 * @param {number} longPeriod  – baseline window (e.g. 24)
 * @returns {number|null} Ratio (> 1 = expansion, < 1 = compression), or null.
 */
function calculateRangeExpansion(candles, shortPeriod, longPeriod) {
  if (!candles || candles.length < longPeriod) return null;

  const range = (c) => Number(c.high) - Number(c.low);

  // Short window: last `shortPeriod` candles
  let shortSum = 0;
  for (let i = candles.length - shortPeriod; i < candles.length; i++) {
    shortSum += range(candles[i]);
  }
  const shortAvg = shortSum / shortPeriod;

  // Long window: last `longPeriod` candles
  let longSum = 0;
  for (let i = candles.length - longPeriod; i < candles.length; i++) {
    longSum += range(candles[i]);
  }
  const longAvg = longSum / longPeriod;

  if (longAvg === 0) return null;
  return shortAvg / longAvg;
}

/**
 * Measure volume expansion by comparing short-term average volume
 * to a longer baseline.
 *
 * @param {number[]} volumeArray – array of volume values (most recent last)
 * @param {number}   shortPeriod
 * @param {number}   longPeriod
 * @returns {number|null} Ratio (> 1 = volume spike).
 */
function calculateVolumeExpansion(volumeArray, shortPeriod, longPeriod) {
  if (!volumeArray || volumeArray.length < longPeriod) return null;

  let shortSum = 0;
  for (let i = volumeArray.length - shortPeriod; i < volumeArray.length; i++) {
    shortSum += Number(volumeArray[i]);
  }
  const shortAvg = shortSum / shortPeriod;

  let longSum = 0;
  for (let i = volumeArray.length - longPeriod; i < volumeArray.length; i++) {
    longSum += Number(volumeArray[i]);
  }
  const longAvg = longSum / longPeriod;

  if (longAvg === 0) return null;
  return shortAvg / longAvg;
}

/**
 * Detect whether the current price is near or breaking the 24h high/low,
 * which signals a potential breakout.
 *
 * @param {number} currentPrice
 * @param {number} high24h
 * @param {number} low24h
 * @param {number} thresholdPercent – how close counts as "near" (e.g. 0.3 = 0.3%)
 * @returns {{ nearHigh: boolean, nearLow: boolean, breakout: boolean }}
 */
function detectBreakout(currentPrice, high24h, low24h, thresholdPercent) {
  const price = Number(currentPrice);
  const high = Number(high24h);
  const low = Number(low24h);

  if (!Number.isFinite(price) || !Number.isFinite(high) || !Number.isFinite(low) || high === 0) {
    return { nearHigh: false, nearLow: false, breakout: false };
  }

  const threshold = thresholdPercent / 100;

  // Price is within threshold% of the 24h high
  const nearHigh = price >= high * (1 - threshold);
  // Price is within threshold% of the 24h low
  const nearLow = price <= low * (1 + threshold);
  // Any proximity counts as breakout signal
  const breakout = nearHigh || nearLow;

  return { nearHigh, nearLow, breakout };
}

module.exports = {
  calculateATR,
  calculateATRSlope,
  calculateRangeExpansion,
  calculateVolumeExpansion,
  detectBreakout
};
