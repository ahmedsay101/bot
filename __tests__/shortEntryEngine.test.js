const ShortEntryEngine = require("../src/core/shortEntryEngine");

/** Build N candles with incrementing prices */
function makeCandles(n, { basePrice = 100, direction = "up", bodyPct = 1, vol = 1000 } = {}) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    const move = direction === "up" ? i * basePrice * bodyPct / 100 : -i * basePrice * bodyPct / 100;
    const open = basePrice + move;
    const close = open + basePrice * bodyPct / 100;
    candles.push({
      open,
      high: Math.max(open, close) + 0.01,
      low: Math.min(open, close) - 0.01,
      close,
      volume: vol
    });
  }
  return candles;
}

/** Build candles showing exhaustion: big bodies followed by shrinking + wicks */
function makeExhaustedCandles() {
  // 5 previous strong bullish candles
  const strong = [];
  for (let i = 0; i < 5; i++) {
    const open = 100 + i * 5;
    const close = open + 5;
    strong.push({
      open,
      high: close + 0.2,
      low: open - 0.1,
      close,
      volume: 2000
    });
  }
  // 3 recent weak candles: tiny body, long upper wick, lower volume
  const weak = [];
  for (let i = 0; i < 3; i++) {
    const base = 125 + i * 0.5;
    weak.push({
      open: base,
      high: base + 3,       // long upper wick
      low: base - 0.5,
      close: base + 0.2,    // tiny body, close near open
      volume: 500
    });
  }
  return [...strong, ...weak];
}

/** Build candles showing confirmation: lower highs + structure break */
function makeConfirmationCandles() {
  return [
    // Swing high 1 at 130
    { open: 120, high: 125, low: 119, close: 124, volume: 1000 },
    { open: 124, high: 130, low: 123, close: 129, volume: 1500 },
    { open: 129, high: 131, low: 126, close: 127, volume: 1200 },
    // Pullback to 122 (swing low / support)
    { open: 127, high: 128, low: 122, close: 123, volume: 1100 },
    // Swing high 2 at 128 (lower than 131)
    { open: 123, high: 128, low: 122, close: 127, volume: 1000 },
    // Rejection candles (double rejection)
    { open: 127, high: 130, low: 125, close: 125.5, volume: 900 },
    { open: 125, high: 129, low: 124, close: 124.5, volume: 800 },
    // Strong bearish candle with volume spike
    { open: 124, high: 125, low: 118, close: 119, volume: 3000 },
  ];
}

describe("ShortEntryEngine", () => {
  let engine;

  beforeEach(() => {
    engine = new ShortEntryEngine();
  });

  test("returns shouldShort=false with insufficient data", () => {
    const result = engine.shouldShort({
      klines5m: [{ open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
      klines1h: [],
      currentPrice: 1.5,
      high24h: 2
    });
    expect(result.shouldShort).toBe(false);
    expect(result.reasoning).toContain("Not enough 5m candle data");
  });

  test("detects momentum weakening when bodies and volume shrink", () => {
    const candles = makeExhaustedCandles();
    const result = engine.shouldShort({
      klines5m: candles,
      klines1h: candles.slice(0, 5),
      currentPrice: 126,
      high24h: 130
    });
    // Should detect body shrink + volume drop at minimum
    expect(result.weakeningMomentumScore).toBeGreaterThanOrEqual(2);
  });

  test("detects exhaustion with long wicks and rejection", () => {
    const candles = makeExhaustedCandles();
    const result = engine.shouldShort({
      klines5m: candles,
      klines1h: candles.slice(0, 5),
      currentPrice: 126,
      high24h: 130
    });
    expect(result.exhaustionScore).toBeGreaterThanOrEqual(1);
  });

  test("detects confirmation with lower highs and structure break", () => {
    const candles = makeConfirmationCandles();
    const result = engine.shouldShort({
      klines5m: candles,
      klines1h: candles.slice(0, 5),
      currentPrice: 119,
      high24h: 131
    });
    expect(result.confirmationScore).toBeGreaterThanOrEqual(2);
  });

  test("flags runner when 1H move is too large", () => {
    const candles5m = makeCandles(10, { basePrice: 100, bodyPct: 0.5, vol: 1000 });
    // 1H candle with huge move
    const klines1h = [{ open: 100, high: 125, low: 99, close: 120, volume: 5000 }];
    const result = engine.shouldShort({
      klines5m: candles5m,
      klines1h: klines1h,
      currentPrice: 120,
      high24h: 125
    });
    // Large 1H move should contribute to runner signals
    const hasRunnerReasoning = result.reasoning.some(r => r.includes("Runner: 1H move"));
    expect(hasRunnerReasoning).toBe(true);
  });

  test("does not short strong uptrend candles", () => {
    // All candles trending up with large bodies and growing volume
    const candles = [];
    for (let i = 0; i < 10; i++) {
      candles.push({
        open: 100 + i * 3,
        high: 103 + i * 3 + 0.5,
        low: 100 + i * 3 - 0.2,
        close: 103 + i * 3,
        volume: 1000 + i * 300
      });
    }
    const result = engine.shouldShort({
      klines5m: candles,
      klines1h: candles.slice(0, 5),
      currentPrice: 130,
      high24h: 131
    });
    expect(result.shouldShort).toBe(false);
  });

  test("output structure has all required fields", () => {
    const candles = makeCandles(10);
    const result = engine.shouldShort({
      klines5m: candles,
      klines1h: candles.slice(0, 5),
      currentPrice: 110,
      high24h: 115
    });
    expect(result).toHaveProperty("shouldShort");
    expect(result).toHaveProperty("weakeningMomentumScore");
    expect(result).toHaveProperty("exhaustionScore");
    expect(result).toHaveProperty("confirmationScore");
    expect(result).toHaveProperty("isRunner");
    expect(result).toHaveProperty("reasoning");
    expect(Array.isArray(result.reasoning)).toBe(true);
  });

  test("custom config overrides defaults", () => {
    const custom = new ShortEntryEngine({ wickRatioThreshold: 3.0, max1hMovePercent: 5 });
    expect(custom.config.wickRatioThreshold).toBe(3.0);
    expect(custom.config.max1hMovePercent).toBe(5);
    // Other defaults preserved
    expect(custom.config.rejectionClosePct).toBe(0.35);
  });
});
