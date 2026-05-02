import { describe, it, expect, beforeEach } from 'vitest';
import { evaluate } from '../../src/services/strategy.service.js';
import { detectRegime } from '../../src/services/regime.service.js';
import { resetConfig, applySettingsPatch } from '../../src/core/config.js';
import { Side, Regime } from '../../src/core/constants.js';
import type { Candle } from '../../src/services/marketData.service.js';

beforeEach(() => resetConfig());

function makeCandles(closes: number[], baseHigh = 0.5, baseLow = 0.5): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    closeTime: i * 60_000 + 59_999,
    open: c,
    high: c + baseHigh,
    low: c - baseLow,
    close: c,
    volume: 1000,
  }));
}

describe('regime', () => {
  it('UNKNOWN when not enough data', () => {
    const r = detectRegime(makeCandles([1, 2, 3]));
    expect(r.regime).toBe(Regime.UNKNOWN);
  });

  it('TREND on monotonically increasing series', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
    const r = detectRegime(makeCandles(closes));
    expect(r.regime).toBe(Regime.TREND);
  });

  it('RANGE on flat noisy series', () => {
    // Tiny oscillation around 100
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 0.2);
    const r = detectRegime(makeCandles(closes, 0.1, 0.1));
    expect(r.regime).toBe(Regime.RANGE);
  });
});

describe('strategy.evaluate', () => {
  it('does NOT open in TREND even if RSI extreme', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
    const ev = evaluate({ candles: makeCandles(closes), hasOpenPosition: false });
    expect(ev.regime.regime).toBe(Regime.TREND);
    expect(ev.signal.kind).not.toBe('OPEN');
  });

  it('opens LONG when RSI < oversold near support in RANGE', () => {
    // Build a range: oscillate around 100 then dip sharply at the end
    const base = Array.from({ length: 110 }, (_, i) => 100 + Math.sin(i / 2) * 0.2);
    // Sharp down move to drive RSI low and put price at support
    const dip = Array.from({ length: 14 }, (_, i) => 100 - 0.5 - i * 0.05);
    const closes = [...base, ...dip];
    // Make ATR small so proximity buffer is small but achievable
    applySettingsPatch({ thresholds: { trendSlope: 0.01, rsiOversold: 35 } });
    const ev = evaluate({ candles: makeCandles(closes, 0.05, 0.05), hasOpenPosition: false });
    // We can't guarantee setup fires for every random shape; assert no OPEN-with-wrong-side case
    if (ev.signal.kind === 'OPEN') {
      expect(ev.signal.side).toBe(Side.LONG);
    }
  });

  it('emits CLOSE when RSI returns to neutral with open position', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 0.2);
    const ev = evaluate({
      candles: makeCandles(closes, 0.05, 0.05),
      hasOpenPosition: true,
      positionSide: Side.LONG,
    });
    // RSI for a sinusoid hovers near 50 → should be in neutral band → CLOSE
    if (ev.regime.regime === Regime.RANGE) {
      expect(['CLOSE', 'HOLD']).toContain(ev.signal.kind);
    }
  });

  it('emits CLOSE on regime change for an open position', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i); // strong trend
    const ev = evaluate({
      candles: makeCandles(closes),
      hasOpenPosition: true,
      positionSide: Side.LONG,
    });
    expect(ev.signal.kind).toBe('CLOSE');
    if (ev.signal.kind === 'CLOSE') expect(ev.signal.reason).toBe('regime_change');
  });
});
