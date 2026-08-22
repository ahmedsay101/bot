/**
 * Multi-TF combine + mapLimit + STRONG gate tests.
 */
import {
  combineMultiTimeframeTrends,
  mapLimit,
  DEFAULT_TREND_DETECTOR_CONFIG,
  emptyTrendView,
} from '../../src/modules/trend/TrendDetector';
import {
  evaluateTrendFromCandles,
  DEFAULT_TREND_CALC_CONFIG,
  type Candle,
} from '../../src/modules/trend/trendCalc';

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

function syntheticBullish(count = 100): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + 0.015);
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.996;
    const volume = i >= count - 8 ? 3000 : 700;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

function syntheticBearish(count = 100): Candle[] {
  const out: Candle[] = [];
  let price = 300;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 - 0.015);
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.995;
    const volume = i >= count - 8 ? 3000 : 700;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

function syntheticSideways(count = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const close = 100 + dir * 0.3;
    out.push(makeCandle(i, 100, close + 0.2, close - 0.2, close, 800));
  }
  return out;
}

describe('combineMultiTimeframeTrends', () => {
  const cfg = { ...DEFAULT_TREND_DETECTOR_CONFIG };

  it('strong bullish both TFs → STRONG confirmed', () => {
    const primary = evaluateTrendFromCandles(syntheticBullish(), cfg.calc);
    const confirm = evaluateTrendFromCandles(syntheticBullish(), cfg.calc);
    const view = combineMultiTimeframeTrends('BTCUSDT', primary, confirm, cfg);
    expect(view.direction).toBe('BULLISH');
    expect(view.strength).toBe('STRONG');
    expect(view.confirmed).toBe(true);
    expect(view.score).toBeGreaterThanOrEqual(cfg.strongMinScore);
  });

  it('strong bearish both TFs → STRONG confirmed', () => {
    const primary = evaluateTrendFromCandles(syntheticBearish(), cfg.calc);
    const confirm = evaluateTrendFromCandles(syntheticBearish(), cfg.calc);
    const view = combineMultiTimeframeTrends('ETHUSDT', primary, confirm, cfg);
    expect(view.direction).toBe('BEARISH');
    expect(view.confirmed).toBe(true);
    expect(view.strength).toBe('STRONG');
  });

  it('conflicting TFs → not STRONG', () => {
    const primary = evaluateTrendFromCandles(syntheticBullish(), cfg.calc);
    const confirm = evaluateTrendFromCandles(syntheticBearish(), cfg.calc);
    const view = combineMultiTimeframeTrends('SOLUSDT', primary, confirm, cfg);
    expect(view.confirmed).toBe(false);
    expect(view.strength).not.toBe('STRONG');
  });

  it('sideways → not STRONG', () => {
    const primary = evaluateTrendFromCandles(syntheticSideways(), cfg.calc);
    const confirm = evaluateTrendFromCandles(syntheticSideways(), cfg.calc);
    const view = combineMultiTimeframeTrends('ADAUSDT', primary, confirm, cfg);
    expect(view.confirmed).toBe(false);
  });
});

describe('mapLimit', () => {
  it('processes all items without early stop', async () => {
    const seen: number[] = [];
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      seen.push(n);
      await new Promise((r) => setTimeout(r, 5));
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('isolates failures when wrapped', async () => {
    const results = await mapLimit(['a', 'b', 'c'], 2, async (s) => {
      if (s === 'b') throw new Error('fail');
      return s;
    }).catch(() => null);
    // mapLimit itself propagates — callers wrap per-item (detectTrendForAll)
    expect(results).toBeNull();

    const safe = await mapLimit(['a', 'b', 'c'], 2, async (s) => {
      try {
        if (s === 'b') throw new Error('fail');
        return s;
      } catch {
        return 'ERR';
      }
    });
    expect(safe).toEqual(['a', 'ERR', 'c']);
  });
});

describe('emptyTrendView', () => {
  it('ERROR status is not confirmed', () => {
    const v = emptyTrendView('X', DEFAULT_TREND_DETECTOR_CONFIG, 'ERROR');
    expect(v.confirmed).toBe(false);
    expect(v.status).toBe('ERROR');
  });
});
