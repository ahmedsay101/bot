/**
 * RegimeAnalyzer.js – Market-data-driven regime detection engine.
 *
 * Classifies the current market environment as:
 *   EXPANSION   – breakout-friendly, trending conditions
 *   VOLATILITY  – range-bound / mean-reversion-friendly
 *   TRANSITION  – uncertain, low-confidence (skip trading)
 *
 * Decision is purely probabilistic and based on market indicators.
 * Trade performance or consecutive losses are NEVER considered.
 */

const {
  calculateATR,
  calculateATRSlope,
  calculateRangeExpansion,
  calculateVolumeExpansion,
  detectBreakout
} = require("../utils/indicators");
const { log } = require("../utils/logger");

/**
 * Default regime configuration.
 * Every threshold is overridable via the config object passed at construction
 * or through analyzeRegime(params.config).
 */
const DEFAULT_REGIME_CONFIG = {
  // ATR calculation
  atrPeriod: 14,             // ATR lookback period (bars)
  atrSlopeLookback: 6,       // How many ATR values back to measure slope
  atrSlopeThreshold: 0.05,   // Normalised slope threshold (5%)

  // Range expansion
  rangeShortPeriod: 6,       // Recent candle window (1h)
  rangeLongPeriod: 24,       // Baseline candle window (1h)
  rangeExpansionThreshold: 1.15,  // Ratio above which = expansion

  // Volume expansion
  volumeShortPeriod: 6,
  volumeLongPeriod: 24,
  volumeExpansionThreshold: 1.3,  // 30% above baseline = spike

  // 24h breakout detection
  breakoutThresholdPercent: 0.3,  // Within 0.3% of 24h high/low

  // Regime decision thresholds
  expansionThreshold: 3,     // Min expansion score to classify as EXPANSION
  compressionThreshold: 3,   // Min compression score to classify as VOLATILITY

  // Maximum possible score (number of scoring criteria)
  maxPossibleScore: 6
};

class RegimeAnalyzer {
  /**
   * @param {object} [overrides] – Config overrides merged on top of defaults.
   */
  constructor(overrides) {
    this.config = { ...DEFAULT_REGIME_CONFIG, ...overrides };
  }

  /**
   * Analyse the current market regime for a given symbol.
   *
   * @param {object} params
   * @param {Array}  params.klines5m     – 5-minute candles  { open, high, low, close, volume }
   * @param {Array}  params.klines1h     – 1-hour candles
   * @param {Array}  params.btcKlines1h  – BTC/USDT 1-hour candles (correlation check)
   * @param {number[]} params.volume5m   – 5-minute volume series
   * @param {number} params.currentPrice
   * @param {number} params.high24h
   * @param {number} params.low24h
   * @param {object} [params.config]     – Per-call config overrides
   * @returns {{ regime: string, expansionScore: number, compressionScore: number,
   *             confidence: number, metrics: object }}
   */
  analyzeRegime(params) {
    const cfg = { ...this.config, ...(params.config || {}) };
    const {
      klines5m,
      klines1h,
      btcKlines1h,
      volume5m,
      currentPrice,
      high24h,
      low24h
    } = params;

    let expansionScore = 0;
    let compressionScore = 0;

    // ──────────────────────────────────────────────
    // 1) 5-minute ATR slope  (short-term volatility trend)
    // ──────────────────────────────────────────────
    const atr5mValues = calculateATR(klines5m, cfg.atrPeriod);
    const atr5mSlope = calculateATRSlope(atr5mValues, cfg.atrSlopeLookback);

    if (atr5mSlope !== null) {
      if (atr5mSlope > cfg.atrSlopeThreshold) {
        expansionScore++;   // Short-term volatility rising
      } else if (atr5mSlope < -cfg.atrSlopeThreshold) {
        compressionScore++; // Short-term volatility falling
      }
    }

    // ──────────────────────────────────────────────
    // 2) 1-hour ATR slope  (medium-term volatility trend)
    // ──────────────────────────────────────────────
    const atr1hValues = calculateATR(klines1h, cfg.atrPeriod);
    const atr1hSlope = calculateATRSlope(atr1hValues, cfg.atrSlopeLookback);

    if (atr1hSlope !== null) {
      if (atr1hSlope > cfg.atrSlopeThreshold) {
        expansionScore++;
      } else if (atr1hSlope < -cfg.atrSlopeThreshold) {
        compressionScore++;
      }
    }

    // ──────────────────────────────────────────────
    // 3) 1-hour Range Expansion  (are candle ranges widening?)
    // ──────────────────────────────────────────────
    const rangeExpansion = calculateRangeExpansion(
      klines1h,
      cfg.rangeShortPeriod,
      cfg.rangeLongPeriod
    );

    if (rangeExpansion !== null) {
      if (rangeExpansion >= cfg.rangeExpansionThreshold) {
        expansionScore++;   // Candle ranges widening
      } else if (rangeExpansion < 1 / cfg.rangeExpansionThreshold) {
        compressionScore++; // Candle ranges narrowing
      }
    }

    // ──────────────────────────────────────────────
    // 4) Volume Expansion  (volume spike detection)
    // ──────────────────────────────────────────────
    const volumeExpansion = calculateVolumeExpansion(
      volume5m,
      cfg.volumeShortPeriod,
      cfg.volumeLongPeriod
    );

    if (volumeExpansion !== null) {
      if (volumeExpansion >= cfg.volumeExpansionThreshold) {
        expansionScore++;   // Volume spiking above baseline
      }
      // Volume alone doesn't confirm compression, so no compressionScore here
    }

    // ──────────────────────────────────────────────
    // 5) 24h Breakout Detection
    // ──────────────────────────────────────────────
    const breakoutSignal = detectBreakout(
      currentPrice,
      high24h,
      low24h,
      cfg.breakoutThresholdPercent
    );

    if (breakoutSignal.breakout) {
      expansionScore++;     // Price testing extremes → breakout regime
    }

    // ──────────────────────────────────────────────
    // 6) BTC Volatility Confirmation  (market-wide regime proxy)
    // ──────────────────────────────────────────────
    const btcAtrValues = calculateATR(btcKlines1h, cfg.atrPeriod);
    const btcAtrSlope = calculateATRSlope(btcAtrValues, cfg.atrSlopeLookback);

    if (btcAtrSlope !== null) {
      if (btcAtrSlope > cfg.atrSlopeThreshold) {
        expansionScore++;   // BTC volatility rising → market expansionary
      } else if (btcAtrSlope < -cfg.atrSlopeThreshold) {
        compressionScore++; // BTC volatility falling → market compressing
      }
    }

    // ──────────────────────────────────────────────
    // REGIME CLASSIFICATION
    // ──────────────────────────────────────────────
    let regime;
    if (expansionScore >= cfg.expansionThreshold && expansionScore > compressionScore) {
      regime = "EXPANSION";
    } else if (compressionScore >= cfg.compressionThreshold && compressionScore > expansionScore) {
      regime = "VOLATILITY";
    } else {
      regime = "TRANSITION";
    }

    // Confidence: how decisive is the signal?
    // 0 = tied / no signal, 1 = all indicators agree
    const confidence = cfg.maxPossibleScore > 0
      ? Math.abs(expansionScore - compressionScore) / cfg.maxPossibleScore
      : 0;

    const result = {
      regime,
      expansionScore,
      compressionScore,
      confidence,
      metrics: {
        atr5mSlope,
        atr1hSlope,
        rangeExpansion,
        volumeExpansion,
        btcAtrSlope,
        breakoutSignal
      }
    };

    log(
      "REGIME",
      `${regime} | exp=${expansionScore} comp=${compressionScore} ` +
      `conf=${confidence.toFixed(2)} | ` +
      `atr5m=${atr5mSlope !== null ? atr5mSlope.toFixed(4) : "n/a"} ` +
      `atr1h=${atr1hSlope !== null ? atr1hSlope.toFixed(4) : "n/a"} ` +
      `range=${rangeExpansion !== null ? rangeExpansion.toFixed(3) : "n/a"} ` +
      `vol=${volumeExpansion !== null ? volumeExpansion.toFixed(3) : "n/a"} ` +
      `btcAtr=${btcAtrSlope !== null ? btcAtrSlope.toFixed(4) : "n/a"} ` +
      `breakout=${breakoutSignal.breakout}`
    );

    return result;
  }
}

module.exports = RegimeAnalyzer;
