/**
 * mapLimit + empty view + detector wiring smoke tests.
 * Selective engine coverage lives in trendEngine.test.ts.
 */
import {
  mapLimit,
  DEFAULT_TREND_DETECTOR_CONFIG,
  emptyTrendView,
  combineMultiTimeframeTrends,
} from '../../src/modules/trend/TrendDetector';

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
  it('ERROR status is not confirmed / NO_TRADE', () => {
    const v = emptyTrendView('X', DEFAULT_TREND_DETECTOR_CONFIG, 'ERROR');
    expect(v.confirmed).toBe(false);
    expect(v.decision).toBe('NO_TRADE');
    expect(v.status).toBe('ERROR');
  });
});

describe('legacy combiner', () => {
  it('never grants TRADE (selective engine is authoritative)', () => {
    const view = combineMultiTimeframeTrends(
      'BTCUSDT',
      {
        direction: 'BULLISH',
        adx: 40,
        signals: {
          emaAlignment: true,
          priceVsEma: true,
          adxStrong: true,
          diConfirms: true,
          momentumOk: true,
          volumeConfirmed: true,
        },
      },
      {
        direction: 'BULLISH',
        adx: 35,
        signals: {
          emaAlignment: true,
          priceVsEma: true,
          adxStrong: true,
          diConfirms: true,
          momentumOk: true,
          volumeConfirmed: true,
        },
      },
      DEFAULT_TREND_DETECTOR_CONFIG,
    );
    expect(view.decision).toBe('NO_TRADE');
    expect(view.confirmed).toBe(false);
  });
});
