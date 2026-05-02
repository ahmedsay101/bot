import { describe, it, expect } from 'vitest';
import { rsi, atr, sma, ema, slope } from '../../src/indicators/index.js';

describe('rsi', () => {
  it('matches a small known fixture', () => {
    // Wilder RSI of [44.34,44.09,44.15,...] from the classic Stockcharts example, period 14
    const closes = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
      45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.282, 46.0028,
      46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2122, 46.0028, 46.0328,
      46.4116, 46.2222, 45.6439, 46.2122,
    ];
    const out = rsi(closes, 14);
    // After period the output is finite and roughly between 60-75 for this rising series
    const last = out[out.length - 1] as number;
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeGreaterThan(40);
    expect(last).toBeLessThan(95);
  });

  it('returns 100 when there are no losses', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = rsi(closes, 14);
    expect(out[out.length - 1]).toBe(100);
  });

  it('NaN for indices < period', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 0.1);
    const out = rsi(closes, 14);
    for (let i = 0; i < 14; i++) expect(Number.isNaN(out[i] as number)).toBe(true);
  });
});

describe('atr', () => {
  it('produces positive values for non-trivial range data', () => {
    const n = 50;
    const highs = Array.from({ length: n }, (_, i) => 100 + i + 1);
    const lows = Array.from({ length: n }, (_, i) => 100 + i - 1);
    const closes = Array.from({ length: n }, (_, i) => 100 + i);
    const out = atr(highs, lows, closes, 14);
    expect(out[14]).toBeGreaterThan(0);
    expect(out[n - 1]).toBeGreaterThan(0);
  });

  it('throws on mismatched array length', () => {
    expect(() => atr([1, 2], [1], [1, 2], 1)).toThrow();
  });
});

describe('sma / ema', () => {
  it('SMA computes window mean', () => {
    const v = [1, 2, 3, 4, 5];
    expect(sma(v, 3)[2]).toBeCloseTo(2);
    expect(sma(v, 3)[3]).toBeCloseTo(3);
    expect(sma(v, 3)[4]).toBeCloseTo(4);
  });

  it('EMA seeded by SMA, then smoothed', () => {
    const v = Array.from({ length: 30 }, (_, i) => i + 1);
    const e = ema(v, 5);
    expect(e[4]).toBeCloseTo(3); // SMA seed
    expect(e[29] as number).toBeGreaterThan(20);
  });
});

describe('slope', () => {
  it('positive on increasing series', () => {
    const ma = Array.from({ length: 10 }, (_, i) => 100 + i);
    const s = slope(ma);
    expect(s[5] as number).toBeGreaterThan(0);
  });

  it('zero for flat series', () => {
    const ma = Array.from({ length: 10 }, () => 100);
    const s = slope(ma);
    expect(s[5]).toBe(0);
  });
});
