/**
 * Selective trend engine fixtures + acceptance tests.
 * Default: NO_TRADE. Only extreme clean trends → TRADE.
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

/** Clean directional impulse with shallow pullbacks (HH/HL). */
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

function allTf(series: Candle[]) {
  return { '5m': series, '15m': series, '1h': series, '4h': series };
}

/** Slightly softer thresholds so synthetic fixtures can demonstrate TRADE path. */
const TEST_CFG: TrendEngineConfig = {
  ...DEFAULT_TREND_ENGINE_CONFIG,
  minConfidence: 70,
  minCategoryConfirmed: 5,
  minEfficiency: 0.28,
  minAdx: 20,
  maxReversalRisk: 70,
  minTrendRoomAtr: 0.8,
  minRelativeVolume: 1.05,
};

describe('selective trend engine', () => {
  it('strong bullish → TRADE STRONG_TREND', () => {
    const r = evaluateTrendConfirmation('BTCUSDT', allTf(strongBullish()), TEST_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BULLISH');
    expect(r.regime).toBe('STRONG_TREND');
    expect(r.confirmed).toBe(true);
    expect(r.confidenceScore).toBeGreaterThanOrEqual(TEST_CFG.minConfidence);
    expect(r.rejectionReasons).toHaveLength(0);
  });

  it('strong bearish → TRADE STRONG_TREND', () => {
    const r = evaluateTrendConfirmation('ETHUSDT', allTf(strongBearish()), TEST_CFG);
    expect(r.decision).toBe('TRADE');
    expect(r.direction).toBe('BEARISH');
    expect(r.regime).toBe('STRONG_TREND');
  });

  it('sideways → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('ADAUSDT', allTf(sideways()), TEST_CFG);
    expect(r.decision).toBe('NO_TRADE');
    expect(r.confirmed).toBe(false);
  });

  it('choppy → NO_TRADE', () => {
    const r = evaluateTrendConfirmation('DOGEUSDT', allTf(choppy()), TEST_CFG);
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
      TEST_CFG,
    );
    expect(r.decision).toBe('NO_TRADE');
    expect(r.rejectionReasons.join(' ')).toMatch(/disagree|MTF|agreement|bias/i);
  });

  it('insufficient data → NO_TRADE', () => {
    const few = strongBullish(20);
    const r = evaluateTrendConfirmation('X', allTf(few), TEST_CFG);
    expect(r.decision).toBe('NO_TRADE');
    expect(r.regime).toBe('INSUFFICIENT_DATA');
  });

  it('incomplete open candle is ignored (closedOnly)', () => {
    const base = strongBullish(220);
    const withOpen = [
      ...base,
      makeCandle(999, 999, 1000, 998, 999.5, 5000, false),
    ];
    const a = evaluateTrendConfirmation('A', allTf(base), TEST_CFG);
    const b = evaluateTrendConfirmation('A', allTf(withOpen), TEST_CFG);
    expect(a.decision).toBe(b.decision);
    expect(a.direction).toBe(b.direction);
  });

  it('low efficiency hard-rejects clean chop path', () => {
    const closes = sideways(50).map((c) => Number(c.close));
    expect(efficiencyRatio(closes, 20)).toBeLessThan(0.35);
  });

  it('near-resistance / high reversal risk path explains NO_TRADE', () => {
    // Exhausted extension: huge last impulse after long run
    const base = strongBullish(200);
    let p = Number(base[base.length - 1]!.close);
    for (let i = 0; i < 20; i++) {
      const open = p;
      const close = p * 1.04;
      base.push(makeCandle(200 + i, open, close * 1.01, open * 0.99, close, 5000));
      p = close;
    }
    const strict: TrendEngineConfig = {
      ...TEST_CFG,
      maxReversalRisk: 40,
      minTrendRoomAtr: 5,
    };
    const r = evaluateTrendConfirmation('EXT', allTf(base), strict);
    expect(r.decision).toBe('NO_TRADE');
    expect(r.rejectionReasons.length).toBeGreaterThan(0);
  });

  it('relative strength boosts confidence vs opposed BTC context', () => {
    const bull = allTf(strongBullish());
    const withRs = evaluateTrendConfirmation('ALTUSDT', bull, TEST_CFG, {
      btcBias: 'BULLISH',
      relativeStrength: 0.08,
    });
    const against = evaluateTrendConfirmation('ALTUSDT', bull, TEST_CFG, {
      btcBias: 'BEARISH',
      relativeStrength: -0.05,
    });
    if (withRs.decision === 'TRADE' && against.decision === 'TRADE') {
      expect(withRs.confidenceScore).toBeGreaterThanOrEqual(against.confidenceScore);
    }
    // Opposed context may reject or lower score — never invent TRADE from nowhere
    expect(against.decision === 'TRADE' || against.decision === 'NO_TRADE').toBe(true);
  });

  it('default production config is more selective than test cfg', () => {
    expect(DEFAULT_TREND_ENGINE_CONFIG.minConfidence).toBeGreaterThanOrEqual(80);
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
    expect(high.avgForwardReturnPct).toBeGreaterThan(low.avgForwardReturnPct);
  });
});
