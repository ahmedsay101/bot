import {
  DEFAULT_TREND_CALC_CONFIG,
  evaluateTrendFromCandles,
  ema,
  calcRoc,
  average,
  type Candle,
  type TrendCalcConfig,
} from '../../src/modules/trend/trendCalc';

const CFG: TrendCalcConfig = { ...DEFAULT_TREND_CALC_CONFIG };

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

/** Strong monotonic uptrend with elevated late volume. */
function syntheticBullish(count = 80): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + 0.012 + (i % 5 === 0 ? 0.004 : 0));
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.997;
    const volume = i >= count - 5 ? 2000 : 800;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

/** Strong monotonic downtrend with elevated late volume. */
function syntheticBearish(count = 80): Candle[] {
  const out: Candle[] = [];
  let price = 200;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 - 0.012 - (i % 5 === 0 ? 0.004 : 0));
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.996;
    const volume = i >= count - 5 ? 2000 : 800;
    out.push(makeCandle(i, open, high, low, close, volume));
    price = close;
  }
  return out;
}

/** Sideways chop around a mean — weak ADX / mixed EMAs. */
function syntheticSideways(count = 80): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    // Alternate micro up/down with no net drift → low ADX, flat ROC
    const dir = i % 2 === 0 ? 1 : -1;
    const open = price;
    const close = 100 + dir * 0.35;
    const high = Math.max(open, close) + 0.15;
    const low = Math.min(open, close) - 0.15;
    out.push(makeCandle(i, open, high, low, close, 900 + (i % 3) * 10));
    price = close;
  }
  return out;
}

describe('trendCalc helpers', () => {
  it('ema seeds with SMA then smooths', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const series = ema(values, 3);
    expect(series).toHaveLength(10);
    expect(series[2]).toBeCloseTo(2, 5); // SMA(1,2,3)
    expect(series[3]).toBeGreaterThan(series[2]!);
  });

  it('average and calcRoc', () => {
    expect(average([2, 4, 6])).toBe(4);
    expect(calcRoc([100, 101, 110], 2)).toBeCloseTo(10, 5);
  });
});

describe('evaluateTrendFromCandles', () => {
  it('strong bullish uptrend → confirmed BULLISH', () => {
    const candles = syntheticBullish(80);
    const result = evaluateTrendFromCandles(candles, CFG);
    expect(result.direction).toBe('BULLISH');
    expect(result.confirmed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(CFG.minScore);
    expect(result.signals.emaAlignment).toBe(true);
    expect(result.signals.priceVsEma).toBe(true);
    expect(result.signals.adxStrong).toBe(true);
    expect(result.signals.momentumOk).toBe(true);
  });

  it('strong bearish downtrend → confirmed BEARISH', () => {
    const candles = syntheticBearish(80);
    const result = evaluateTrendFromCandles(candles, CFG);
    expect(result.direction).toBe('BEARISH');
    expect(result.confirmed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(CFG.minScore);
    expect(result.signals.emaAlignment).toBe(true);
    expect(result.signals.priceVsEma).toBe(true);
    expect(result.signals.adxStrong).toBe(true);
    expect(result.signals.momentumOk).toBe(true);
  });

  it('sideways chop → not STRONG', () => {
    const candles = syntheticSideways(80);
    const result = evaluateTrendFromCandles(candles, CFG);
    expect(result.strength).not.toBe('STRONG');
    // Prefer no direction, or low score if a weak lean appears
    if (result.direction === 'NONE') {
      expect(result.score).toBe(0);
    } else {
      expect(result.score).toBeLessThan(6);
    }
  });

  it('insufficient candles → not confirmed NONE', () => {
    const candles = syntheticBullish(10);
    const result = evaluateTrendFromCandles(candles, CFG);
    expect(result.direction).toBe('NONE');
    expect(result.confirmed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.signals.emaAlignment).toBe(false);
  });

  it('excludes open (isClosed=false) candles from indicators', () => {
    const base = syntheticBullish(80);
    // Append a wildly bearish open candle that must be ignored
    const last = base[base.length - 1]!;
    base.push(
      makeCandle(
        base.length,
        Number(last.close),
        Number(last.close),
        Number(last.close) * 0.5,
        Number(last.close) * 0.5,
        50,
        false,
      ),
    );
    const result = evaluateTrendFromCandles(base, CFG);
    expect(result.direction).toBe('BULLISH');
    expect(result.confirmed).toBe(true);
  });
});
