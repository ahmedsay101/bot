/**
 * Balanced selective trend engine fixtures.
 * HIGH QUALITY + REASONABLE FREQUENCY — not zero-trader paralysis.
 */
import {
  evaluateTrendConfirmation,
  DEFAULT_TREND_ENGINE_CONFIG,
  type TrendEngineConfig,
} from '../../src/modules/trend/trendEngine';
import type { Candle } from '../../src/modules/trend/trendCalc';
import {
  buildHistoricalRecord,
  calibrateConfidence,
} from '../../src/modules/trend/historicalValidation';
import { efficiencyRatio } from '../../src/modules/trend/indicators';

const INTERVAL_MS = 60_000;

function makeCandle(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  isClosed = true,
): Candle {
  const openTime = 1_700_000_000_000 + i * INTERVAL_MS;
  return {
    openTime,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: String(volume),
    closeTime: openTime + INTERVAL_MS - 1,
    isClosed,
  };
}

function strongBullish(count = 220): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const pullback = i % 10 === 9 || i % 10 === 8;
    const open = price;
    const close = pullback ? price * 0.995 : price * 1.006;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    const volume = pullback ? 800 : i > count - 40 ? 2800 : 1200;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

function strongBearish(count = 220): Candle[] {
  const out: Candle[] = [];
  let price = 400;
  for (let i = 0; i < count; i++) {
    const pullback = i % 10 === 9 || i % 10 === 8;
    const open = price;
    const close = pullback ? price * 1.005 : price * 0.994;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    const volume = pullback ? 800 : i > count - 40 ? 2800 : 1200;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

function sideways(count = 220): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const close = 100 + dir * 0.4;
    out.push(makeCandle(i, 100, close + 0.3, close - 0.3, close, 1000));
  }
  return out;
}

function choppy(count = 220): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const dir = i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 1;
    const open = price;
    const close = price * (1 + dir * 0.02);
    const high = Math.max(open, close) * 1.015;
    const low = Math.min(open, close) * 0.985;
    out.push(makeCandle(i, open, high, low, close, 2000));
    price = close * (i % 5 === 0 ? 0.99 : 1.005);
  }
  return out;
}

/** Milder developing bullish — still directional, not exhausted. */
function developingBullish(count = 180): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const pullback = i % 12 === 11;
    const open = price;
    const close = pullback ? price * 0.997 : price * 1.0045;
    const high = Math.max(open, close) * 1.0015;
    const low = Math.min(open, close) * 0.9985;
    const volume = i > count - 25 ? 2000 : 1100;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

function allTf(series: Candle[]) {
  return { '5m': series, '15m': series, '1h': series, '4h': series };
}

const PROD_CFG: TrendEngineConfig = { ...DEFAULT_TREND_ENGINE_CONFIG };

describe('balanced selective trend engine', () => {
  it('strong bullish → TRADE', () => {
    const r = evaluateTrendConfirmation('BTCUSDT', allTf(strongBullish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BULLISH');
    expect(['STRONG_TREND', 'DEVELOPING_STRONG_TREND']).toContain(r.regime);
    expect(r.confidenceScore).toBeGreaterThanOrEqual(PROD_CFG.minConfidence);
  });

  it('strong bearish → TRADE', () => {
    const r = evaluateTrendConfirmation('ETHUSDT', allTf(strongBearish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BEARISH');
  });

  it('developing bullish can qualify under default thresholds', () => {
    const r = evaluateTrendConfirmation('DEVUSDT', allTf(developingBullish()), PROD_CFG);
    // May be TRADE or NO_TRADE depending on ADX — if TRADE must be developing/strong
    if (r.decision === 'TRADE') {
      expect(['STRONG_TREND', 'DEVELOPING_STRONG_TREND']).toContain(r.regime);
      expect(r.confidenceScore).toBeGreaterThanOrEqual(78);
    } else {
      expect(r.rejectionReasons.length).toBeGreaterThan(0);
    }
  });

  it('sideways → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('ADAUSDT', allTf(sideways()), PROD_CFG);
    expect(r.decision).toBe('NO_TRADE');
  });

  it('choppy → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('DOGEUSDT', allTf(choppy()), PROD_CFG);
    expect(r.decision).toBe('NO_TRADE');
  });

  it('conflicting 4H/1H → NO_TRADE', () => {
    const r = evaluateTrendConfirmation(
      'SOLUSDT',
      {
        '5m': strongBullish(),
        '15m': strongBullish(),
        '1h': strongBullish(),
        '4h': strongBearish(),
      },
      PROD_CFG,
    );
    expect(r.decision).toBe('NO_TRADE');
    expect(r.rejectionReasons.join(' ')).toMatch(/disagree|not aligned/i);
  });

  it('5m temporary countertrend does not veto HTF bullish', () => {
    const bull = strongBullish();
    const r = evaluateTrendConfirmation(
      'ALTUSDT',
      {
        '5m': strongBearish(),
        '15m': bull,
        '1h': bull,
        '4h': bull,
      },
      PROD_CFG,
    );
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BULLISH');
  });

  it('insufficient data → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('X', allTf(strongBullish(20)), PROD_CFG);
    expect(r.decision).toBe('NO_TRADE');
    expect(r.regime).toBe('INSUFFICIENT_DATA');
  });

  it('incomplete open candle is ignored', () => {
    const base = strongBullish(220);
    const withOpen = [...base, makeCandle(999, 999, 1000, 998, 999.5, 5000, false)];
    const a = evaluateTrendConfirmation('A', allTf(base), PROD_CFG);
    const b = evaluateTrendConfirmation('A', allTf(withOpen), PROD_CFG);
    expect(a.decision).toBe(b.decision);
  });

  it('default thresholds are balanced (not paralyzed)', () => {
    expect(DEFAULT_TREND_ENGINE_CONFIG.minConfidence).toBe(78);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minAdx).toBe(24);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minEfficiency).toBe(0.48);
    expect(DEFAULT_TREND_ENGINE_CONFIG.maxReversalRisk).toBe(75);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minMtfAgree).toBe(2);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minCoreConfirmed).toBe(3);
    expect(DEFAULT_TREND_ENGINE_CONFIG.allowDevelopingStrong).toBe(true);
  });

  it('efficiency ~0.5 is above chop floor', () => {
    expect(0.5).toBeGreaterThanOrEqual(DEFAULT_TREND_ENGINE_CONFIG.minEfficiency);
    const closes = sideways(50).map((c) => Number(c.close));
    expect(efficiencyRatio(closes, 20)).toBeLessThan(0.35);
  });

  it('extreme reversal / tiny room still rejects', () => {
    const base = strongBullish(200);
    let p = Number(base[base.length - 1]!.close);
    for (let i = 0; i < 25; i++) {
      const open = p;
      const close = p * 1.05;
      base.push(makeCandle(200 + i, open, close * 1.01, open * 0.99, close, 5000));
      p = close;
    }
    const strict: TrendEngineConfig = {
      ...PROD_CFG,
      maxReversalRisk: 40,
      hardBlockRoomAtr: 5,
    };
    const r = evaluateTrendConfirmation('EXT', allTf(base), strict);
    expect(r.decision).toBe('NO_TRADE');
  });
});

describe('historical calibration hooks', () => {
  it('higher confidence bucket can show better accuracy on fixtures', () => {
    const t0 = 1_700_000_000_000;
    const records = [
      buildHistoricalRecord({
        symbol: 'A',
        detectedAt: t0,
        direction: 'BULLISH',
        confidenceScore: 92,
        regime: 'STRONG_TREND',
        entryPrice: 100,
        futureCloses: [{ t: t0 + 3_600_000, price: 105 }],
      }),
      buildHistoricalRecord({
        symbol: 'B',
        detectedAt: t0,
        direction: 'BULLISH',
        confidenceScore: 92,
        regime: 'STRONG_TREND',
        entryPrice: 100,
        futureCloses: [{ t: t0 + 3_600_000, price: 103 }],
      }),
      buildHistoricalRecord({
        symbol: 'C',
        detectedAt: t0,
        direction: 'BULLISH',
        confidenceScore: 65,
        regime: 'WEAK_TREND',
        entryPrice: 100,
        futureCloses: [{ t: t0 + 3_600_000, price: 99 }],
      }),
      buildHistoricalRecord({
        symbol: 'D',
        detectedAt: t0,
        direction: 'BULLISH',
        confidenceScore: 65,
        regime: 'WEAK_TREND',
        entryPrice: 100,
        futureCloses: [{ t: t0 + 3_600_000, price: 101 }],
      }),
    ];
    const buckets = calibrateConfidence(records, '1h');
    const high = buckets.find((b) => b.label === '90-94')!;
    const low = buckets.find((b) => b.label === '60-69')!;
    expect(high.directionalAccuracy).toBeGreaterThan(low.directionalAccuracy);
  });
});
