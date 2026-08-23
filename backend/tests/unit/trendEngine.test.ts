/**
 * Moderate-relaxation selective trend engine fixtures.
 * Smart + selective + realistic frequency — not paralyzed, not careless.
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
    out.push(makeCandle(i, open, high, low, close, 1800 + (i % 7) * 40));
    price = close * (i % 5 === 0 ? 0.99 : 1.005);
  }
  return out;
}

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

function developingBearish(count = 200): Candle[] {
  const out: Candle[] = [];
  let price = 400;
  for (let i = 0; i < count; i++) {
    const pullback = i % 12 === 11;
    const open = price;
    const close = pullback ? price * 1.003 : price * 0.9955;
    const high = Math.max(open, close) * 1.0015;
    const low = Math.min(open, close) * 0.9985;
    const volume = i > count - 25 ? 2000 : 1100;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

function strongBullishFlatVolume(count = 220): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const pullback = i % 10 === 9 || i % 10 === 8;
    const open = price;
    const close = pullback ? price * 0.995 : price * 1.006;
    out.push(makeCandle(i, open, Math.max(open, close) * 1.002, Math.min(open, close) * 0.998, close, 1000));
    price = close;
  }
  return out;
}

function risingStrengthBullish(count = 160): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const accel = i < 90 ? 1.0022 : 1.0042;
    const pullback = i % 14 === 13;
    const open = price;
    const close = pullback ? price * 0.9988 : price * accel;
    out.push(makeCandle(i, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close, 1100));
    price = close;
  }
  return out;
}

function allTf(series: Candle[]) {
  return { '5m': series, '15m': series, '1h': series, '4h': series };
}

const PROD_CFG: TrendEngineConfig = { ...DEFAULT_TREND_ENGINE_CONFIG };

describe('moderate-relaxation selective trend engine', () => {
  it('strong bullish → STRONG/DEVELOPING + eligible', () => {
    const r = evaluateTrendConfirmation('BTCUSDT', allTf(strongBullish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BULLISH');
    expect(r.eligible).toBe(true);
    expect(['STRONG_TREND', 'DEVELOPING_STRONG_TREND']).toContain(r.regime);
    expect(r.confidenceScore).toBeGreaterThanOrEqual(PROD_CFG.minConfidence);
  });

  it('strong bearish → eligible', () => {
    const r = evaluateTrendConfirmation('ETHUSDT', allTf(strongBearish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BEARISH');
    expect(r.eligible).toBe(true);
  });

  it('developing bullish → eligible', () => {
    const r = evaluateTrendConfirmation('DEVUSDT', allTf(developingBullish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BULLISH');
    expect(['STRONG_TREND', 'DEVELOPING_STRONG_TREND']).toContain(r.regime);
    expect(r.confidenceScore).toBeGreaterThanOrEqual(72);
  });

  it('developing bearish → eligible', () => {
    const r = evaluateTrendConfirmation('DEVB', allTf(developingBearish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BEARISH');
    expect(r.eligible).toBe(true);
  });

  it('5m neutral but 4H/1H/15M aligned → eligible', () => {
    const bull = strongBullish();
    const r = evaluateTrendConfirmation(
      'NEUT5',
      { '5m': sideways(), '15m': bull, '1h': bull, '4h': bull },
      PROD_CFG,
    );
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BULLISH');
  });

  it('5m countertrend does not veto HTF bullish', () => {
    const bull = strongBullish();
    const r = evaluateTrendConfirmation(
      'ALTUSDT',
      { '5m': strongBearish(), '15m': bull, '1h': bull, '4h': bull },
      PROD_CFG,
    );
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BULLISH');
  });

  it('average (~1x) volume still eligible when CORE strong', () => {
    const r = evaluateTrendConfirmation('AVGVOL', allTf(strongBullishFlatVolume()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.metrics.relativeVolume).toBeLessThan(1.15);
  });

  it('efficiency ~0.50 band is acceptable (not auto-reject)', () => {
    expect(0.5).toBeGreaterThanOrEqual(DEFAULT_TREND_ENGINE_CONFIG.minEfficiency);
    const closes = sideways(50).map((c) => Number(c.close));
    expect(efficiencyRatio(closes, 20)).toBeLessThan(0.35);
    const r = evaluateTrendConfirmation('ER', allTf(strongBullish()), PROD_CFG);
    expect(r.metrics.efficiencyRatio).toBeGreaterThanOrEqual(0.45);
    expect(r.decision).toBe('TRADE');
  });

  it('rising-strength / developing ADX path can qualify', () => {
    const r = evaluateTrendConfirmation('RISE', allTf(risingStrengthBullish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(['STRONG_TREND', 'DEVELOPING_STRONG_TREND']).toContain(r.regime);
    expect(r.metrics.adx).toBeGreaterThanOrEqual(PROD_CFG.minAdx - 3);
  });

  it('RSI elevated (strong trend) does not auto-reject', () => {
    const r = evaluateTrendConfirmation('RSI', allTf(strongBullish()), PROD_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.signals.momentum.detail).toMatch(/RSI=\d+/);
  });

  it('conflicting 4H/1H → NO_TRADE HTF_CONFLICT', () => {
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
    expect(r.rejectionCodes).toContain('HTF_CONFLICT');
  });

  it('sideways → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('ADAUSDT', allTf(sideways()), PROD_CFG);
    expect(r.decision).toBe('NO_TRADE');
    expect(r.eligible).toBe(false);
  });

  it('choppy → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('DOGEUSDT', allTf(choppy()), PROD_CFG);
    expect(r.decision).toBe('NO_TRADE');
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

  it('insufficient data → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('X', allTf(strongBullish(20)), PROD_CFG);
    expect(r.decision).toBe('NO_TRADE');
    expect(r.regime).toBe('INSUFFICIENT_DATA');
    expect(r.rejectionCodes).toContain('INSUFFICIENT_DATA');
  });

  it('preserves tradeable regime on LOW_CONFIDENCE', () => {
    const strict: TrendEngineConfig = { ...PROD_CFG, minConfidence: 99 };
    const r = evaluateTrendConfirmation('NEAR', allTf(strongBullish()), strict);
    expect(r.decision).toBe('NO_TRADE');
    expect(r.rejectionCodes).toContain('LOW_CONFIDENCE');
    expect(['STRONG_TREND', 'DEVELOPING_STRONG_TREND']).toContain(r.regime);
  });

  it('incomplete open candle is ignored', () => {
    const base = strongBullish(220);
    const withOpen = [...base, makeCandle(999, 999, 1000, 998, 999.5, 5000, false)];
    const a = evaluateTrendConfirmation('A', allTf(base), PROD_CFG);
    const b = evaluateTrendConfirmation('A', allTf(withOpen), PROD_CFG);
    expect(a.decision).toBe(b.decision);
  });

  it('default thresholds match moderate relaxation', () => {
    expect(DEFAULT_TREND_ENGINE_CONFIG.minConfidence).toBe(72);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minAdx).toBe(22);
    expect(DEFAULT_TREND_ENGINE_CONFIG.strongAdx).toBe(28);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minEfficiency).toBe(0.45);
    expect(DEFAULT_TREND_ENGINE_CONFIG.maxReversalRisk).toBe(75);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minMtfAgree).toBe(2);
    expect(DEFAULT_TREND_ENGINE_CONFIG.minCoreConfirmed).toBe(4);
    expect(DEFAULT_TREND_ENGINE_CONFIG.weakVolumeRatio).toBe(0.7);
    expect(DEFAULT_TREND_ENGINE_CONFIG.allowDevelopingStrong).toBe(true);
  });

  it('diagnostics expose core/supporting and rejection codes', () => {
    const ok = evaluateTrendConfirmation('D1', allTf(strongBullish()), PROD_CFG);
    expect(ok.coreSignalsPassed).toBeGreaterThanOrEqual(3);
    expect(ok.metrics.h4Bias).toBeDefined();
    const bad = evaluateTrendConfirmation('D2', allTf(sideways()), PROD_CFG);
    expect(bad.rejectionCodes.length).toBeGreaterThan(0);
    expect(bad.eligible).toBe(false);
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
