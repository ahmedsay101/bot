/**
 * ShortEntryEngine — determines whether a coin shows exhaustion
 * and is safe to short. Uses multi-step analysis:
 *   1. Momentum weakening
 *   2. Exhaustion detection
 *   3. Confirmation of reversal
 *   4. Runner filter (avoid unstoppable coins)
 */

const DEFAULT_CONFIG = {
  // Wick must be this many times the body to count as rejection
  wickRatioThreshold: 1.5,
  // Rejection: close must be within this % of the candle range from the low
  rejectionClosePct: 0.35,
  // Max allowed 1h move before we label it a runner
  max1hMovePercent: 15,
  // Min pullback % to count as a real pullback (runner filter)
  minPullbackPercent: 2,
  // Volume spike multiplier for bearish shift confirmation
  volumeSpikeMult: 1.5
};

// ── Helpers ───────────────────────────────────────────────────

/** Average of an array of numbers */
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Body size of a candle (always positive) */
function bodySize(c) {
  return Math.abs(c.close - c.open);
}

/** Upper wick size */
function upperWick(c) {
  return c.high - Math.max(c.open, c.close);
}

/** True range of a candle */
function range(c) {
  return c.high - c.low;
}

/** Percentage move of a candle relative to its open */
function candlePctMove(c) {
  if (c.open === 0) return 0;
  return Math.abs(c.close - c.open) / c.open * 100;
}

/**
 * Find swing highs in a candle array.
 * A swing high is a candle whose high is greater than its neighbours.
 */
function findSwingHighs(candles) {
  const highs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      highs.push({ index: i, value: candles[i].high });
    }
  }
  return highs;
}

/**
 * Find swing lows (local supports).
 */
function findSwingLows(candles) {
  const lows = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      lows.push({ index: i, value: candles[i].low });
    }
  }
  return lows;
}

// ── Engine ────────────────────────────────────────────────────

class ShortEntryEngine {
  constructor(userConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...userConfig };
  }

  /**
   * Analyse a symbol and decide whether to short.
   *
   * @param {object} params
   * @param {Candle[]} params.klines5m  – recent 5-minute candles (newest last)
   * @param {Candle[]} params.klines1h  – recent 1-hour candles (newest last)
   * @param {number}   params.currentPrice
   * @param {number}   params.high24h
   * @returns {{ shouldShort, weakeningMomentumScore, exhaustionScore, confirmationScore, isRunner, reasoning }}
   */
  shouldShort(params) {
    const { klines5m, klines1h, currentPrice, high24h } = params;
    const cfg = this.config;
    const reasoning = [];

    // Need enough candles for analysis (8 recent = 3 recent + 5 previous)
    if (!klines5m || klines5m.length < 8) {
      reasoning.push("Not enough 5m candle data");
      return this._result(false, 0, 0, 0, false, reasoning);
    }

    // ── Step 1: Momentum weakening (0-4) ──────────────────────
    const weakeningMomentumScore = this._checkMomentumWeakening(klines5m, reasoning);

    // ── Step 2: Exhaustion detection (0-4) ────────────────────
    const exhaustionScore = this._checkExhaustion(klines5m, cfg, reasoning);

    // ── Step 3: Confirmation (0-4) ────────────────────────────
    const confirmationScore = this._checkConfirmation(klines5m, currentPrice, reasoning);

    // ── Step 4: Runner filter ─────────────────────────────────
    const isRunner = this._checkRunner(klines5m, klines1h, cfg, reasoning);

    // ── Step 5: Final decision ────────────────────────────────
    const shouldShort =
      weakeningMomentumScore >= 2 &&
      exhaustionScore >= 2 &&
      confirmationScore >= 2 &&
      !isRunner;

    if (shouldShort) {
      reasoning.push("All conditions met → SHORT");
    } else {
      reasoning.push(`Conditions not met: momentum=${weakeningMomentumScore} exhaustion=${exhaustionScore} confirmation=${confirmationScore} runner=${isRunner}`);
    }

    return this._result(shouldShort, weakeningMomentumScore, exhaustionScore, confirmationScore, isRunner, reasoning);
  }

  // ── Step 1: Momentum weakening ──────────────────────────────

  _checkMomentumWeakening(candles, reasoning) {
    let score = 0;
    // Split into previous 5 and recent 3
    const recent = candles.slice(-3);
    const previous = candles.slice(-8, -3);

    // 1a) Candle body shrink – recent body avg < previous body avg
    const recentBodyAvg = avg(recent.map(bodySize));
    const prevBodyAvg = avg(previous.map(bodySize));
    if (prevBodyAvg > 0 && recentBodyAvg < prevBodyAvg * 0.8) {
      score++;
      reasoning.push(`Body shrink: recent avg ${recentBodyAvg.toFixed(6)} < prev ${prevBodyAvg.toFixed(6)}`);
    }

    // 1b) Slower price acceleration – recent % moves < previous
    const recentPctAvg = avg(recent.map(candlePctMove));
    const prevPctAvg = avg(previous.map(candlePctMove));
    if (prevPctAvg > 0 && recentPctAvg < prevPctAvg * 0.8) {
      score++;
      reasoning.push(`Slower acceleration: recent ${recentPctAvg.toFixed(4)}% < prev ${prevPctAvg.toFixed(4)}%`);
    }

    // 1c) Increasing pullbacks – measure pullback depth between swing highs
    const swingHighs = findSwingHighs(candles);
    if (swingHighs.length >= 2) {
      const pullbacks = [];
      for (let i = 1; i < swingHighs.length; i++) {
        // Find the lowest low between consecutive swing highs
        let minLow = Infinity;
        for (let j = swingHighs[i - 1].index; j <= swingHighs[i].index; j++) {
          if (candles[j].low < minLow) minLow = candles[j].low;
        }
        const pullbackPct = (swingHighs[i - 1].value - minLow) / swingHighs[i - 1].value * 100;
        pullbacks.push(pullbackPct);
      }
      // Check if the latest pullback is deeper than earlier ones
      if (pullbacks.length >= 2 && pullbacks[pullbacks.length - 1] > pullbacks[pullbacks.length - 2]) {
        score++;
        reasoning.push("Increasing pullback depth");
      }
    }

    // 1d) Volume plateau or drop
    const recentVolAvg = avg(recent.map(c => c.volume));
    const prevVolAvg = avg(previous.map(c => c.volume));
    if (prevVolAvg > 0 && recentVolAvg < prevVolAvg * 0.8) {
      score++;
      reasoning.push(`Volume drop: recent ${recentVolAvg.toFixed(2)} < prev ${prevVolAvg.toFixed(2)}`);
    }

    return score;
  }

  // ── Step 2: Exhaustion detection ────────────────────────────

  _checkExhaustion(candles, cfg, reasoning) {
    let score = 0;
    const recent = candles.slice(-3);

    for (const c of recent) {
      const body = bodySize(c);
      const wick = upperWick(c);
      const candleRange = range(c);

      // 2a) Long upper wick
      if (body > 0 && wick > body * cfg.wickRatioThreshold) {
        score++;
        reasoning.push(`Long upper wick: wick=${wick.toFixed(6)} > body*${cfg.wickRatioThreshold}=${(body * cfg.wickRatioThreshold).toFixed(6)}`);
        break; // Count once
      }
    }

    // 2b) Strong rejection candle – close is in the lower portion of the range
    for (const c of recent) {
      const candleRange = range(c);
      if (candleRange > 0) {
        const closePosition = (c.close - c.low) / candleRange;
        if (closePosition < cfg.rejectionClosePct) {
          score++;
          reasoning.push(`Rejection candle: close at ${(closePosition * 100).toFixed(1)}% of range`);
          break;
        }
      }
    }

    // 2c) Failed breakout – price exceeds a prior high then closes below it
    if (candles.length >= 4) {
      const priorHigh = Math.max(...candles.slice(-6, -2).map(c => c.high));
      const last = candles[candles.length - 1];
      if (last.high > priorHigh && last.close < priorHigh) {
        score++;
        reasoning.push(`Failed breakout: high ${last.high.toFixed(6)} > prior ${priorHigh.toFixed(6)}, closed below`);
      }
    }

    // 2d) Large bearish candle after uptrend (big red with high volume)
    if (candles.length >= 2) {
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const isBearish = last.close < last.open;
      const body = bodySize(last);
      const prevBody = bodySize(prev);
      if (isBearish && body > prevBody * 1.5 && last.volume > prev.volume) {
        score++;
        reasoning.push("Large bearish candle with volume");
      }
    }

    return Math.min(score, 4);
  }

  // ── Step 3: Confirmation ────────────────────────────────────

  _checkConfirmation(candles, currentPrice, reasoning) {
    let score = 0;

    // 3a) Lower high – last swing high < previous swing high
    const swingHighs = findSwingHighs(candles);
    if (swingHighs.length >= 2) {
      const lastHigh = swingHighs[swingHighs.length - 1].value;
      const prevHigh = swingHighs[swingHighs.length - 2].value;
      if (lastHigh < prevHigh) {
        score++;
        reasoning.push(`Lower high: ${lastHigh.toFixed(6)} < ${prevHigh.toFixed(6)}`);
      }
    }

    // 3b) Break of local structure – price below recent support
    const swingLows = findSwingLows(candles);
    if (swingLows.length >= 1) {
      const recentSupport = swingLows[swingLows.length - 1].value;
      if (currentPrice < recentSupport) {
        score++;
        reasoning.push(`Structure break: price ${currentPrice.toFixed(6)} < support ${recentSupport.toFixed(6)}`);
      }
    }

    // 3c) Double rejection – two consecutive candles with upper wick > body
    const tail = candles.slice(-4);
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1];
      const b = tail[i];
      if (upperWick(a) > bodySize(a) && upperWick(b) > bodySize(b)) {
        score++;
        reasoning.push("Double rejection candles");
        break;
      }
    }

    // 3d) Bearish momentum shift – strong red candle with volume spike
    if (candles.length >= 6) {
      const last = candles[candles.length - 1];
      const prevVols = candles.slice(-6, -1).map(c => c.volume);
      const avgVol = avg(prevVols);
      const isBearish = last.close < last.open;
      if (isBearish && last.volume > avgVol * this.config.volumeSpikeMult) {
        score++;
        reasoning.push("Bearish momentum shift: red candle + volume spike");
      }
    }

    return Math.min(score, 4);
  }

  // ── Step 4: Runner detection ────────────────────────────────

  _checkRunner(candles5m, candles1h, cfg, reasoning) {
    let runnerSignals = 0;

    // 4a) Last 1H move too large
    if (candles1h && candles1h.length >= 1) {
      const last1h = candles1h[candles1h.length - 1];
      const move = Math.abs(last1h.close - last1h.open) / last1h.open * 100;
      if (move > cfg.max1hMovePercent) {
        runnerSignals++;
        reasoning.push(`Runner: 1H move ${move.toFixed(2)}% > ${cfg.max1hMovePercent}%`);
      }
    }

    // 4b) Volume increasing strongly over recent candles
    if (candles5m.length >= 6) {
      const firstHalf = candles5m.slice(-6, -3).map(c => c.volume);
      const secondHalf = candles5m.slice(-3).map(c => c.volume);
      if (avg(secondHalf) > avg(firstHalf) * 1.5) {
        runnerSignals++;
        reasoning.push("Runner: volume strongly increasing");
      }
    }

    // 4c) No pullbacks > minPullbackPercent
    const swingHighs = findSwingHighs(candles5m);
    if (swingHighs.length >= 2) {
      let hasPullback = false;
      for (let i = 1; i < swingHighs.length; i++) {
        let minLow = Infinity;
        for (let j = swingHighs[i - 1].index; j <= swingHighs[i].index; j++) {
          if (candles5m[j].low < minLow) minLow = candles5m[j].low;
        }
        const pullback = (swingHighs[i - 1].value - minLow) / swingHighs[i - 1].value * 100;
        if (pullback >= cfg.minPullbackPercent) hasPullback = true;
      }
      if (!hasPullback) {
        runnerSignals++;
        reasoning.push(`Runner: no pullbacks >= ${cfg.minPullbackPercent}%`);
      }
    }

    // 4d) Continuous higher highs with large bodies
    if (candles5m.length >= 5) {
      const tail = candles5m.slice(-5);
      let higherHighs = 0;
      let largeBodies = 0;
      const avgBody = avg(candles5m.slice(-10, -5).map(bodySize)) || avg(tail.map(bodySize));
      for (let i = 1; i < tail.length; i++) {
        if (tail[i].high > tail[i - 1].high) higherHighs++;
        if (bodySize(tail[i]) > avgBody * 1.2) largeBodies++;
      }
      if (higherHighs >= 3 && largeBodies >= 3) {
        runnerSignals++;
        reasoning.push("Runner: continuous higher highs with large bodies");
      }
    }

    // Consider it a runner if 2+ signals fire
    return runnerSignals >= 2;
  }

  // ── Result builder ──────────────────────────────────────────

  _result(shouldShort, weakeningMomentumScore, exhaustionScore, confirmationScore, isRunner, reasoning) {
    return {
      shouldShort,
      weakeningMomentumScore,
      exhaustionScore,
      confirmationScore,
      isRunner,
      reasoning
    };
  }
}

module.exports = ShortEntryEngine;
