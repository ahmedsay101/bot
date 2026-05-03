import { describe, it, expect, beforeEach } from 'vitest';
import {
  GridEngine,
  buildRange,
  generateLevels,
  detectBreakout,
  countBoundaryCrosses,
  type IGridExecutionAdapter,
  type PlaceOrderArgs,
} from '../../src/services/gridEngine.service.js';
import { resetConfig, applySettingsPatch } from '../../src/core/config.js';
import { BotState } from '../../src/core/gridState.js';
import { Side } from '../../src/core/constants.js';
import type { Candle } from '../../src/services/marketData.service.js';

beforeEach(() => {
  resetConfig();
  // Force universeSize=1, no minNotional surprises in tests.
  applySettingsPatch({ filters: { minVolume: 0 } });
});

function flat(closes: number[], spread = 0.5): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 5 * 60_000,
    closeTime: i * 5 * 60_000 + 5 * 60_000 - 1,
    open: c,
    high: c + spread,
    low: c - spread,
    close: c,
    volume: 1000,
  }));
}

class MockExec implements IGridExecutionAdapter {
  placed: PlaceOrderArgs[] = [];
  cancelled: string[] = [];
  pnl: { qty: number; pnl: number; reason: string }[] = [];

  async placeOrder(args: PlaceOrderArgs): Promise<void> {
    this.placed.push(args);
  }
  async cancelOrder(_s: string, cid: string): Promise<void> {
    this.cancelled.push(cid);
  }
  async creditRealizedPnl(args: {
    symbol: string;
    side: Side;
    entryPrice: number;
    exitPrice: number;
    qty: number;
    fees: number;
    leverage: number;
    reason: string;
    openedAt: number;
  }): Promise<void> {
    const dir = args.side === Side.LONG ? 1 : -1;
    this.pnl.push({
      qty: args.qty,
      pnl: (args.exitPrice - args.entryPrice) * args.qty * dir,
      reason: args.reason,
    });
  }
  symbolFilters(): { tickSize: number; stepSize: number; minNotional: number } {
    return { tickSize: 0.01, stepSize: 0.0001, minNotional: 1 };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('buildRange', () => {
  it('returns null when not enough candles', () => {
    expect(buildRange(flat([100, 100]), 100)).toBeNull();
  });

  it('builds bands with buffer and clamps narrow range to min', () => {
    const candles = flat(Array.from({ length: 30 }, () => 100), 0.05);
    const r = buildRange(candles, 100)!;
    expect(r).not.toBeNull();
    // Range too narrow → expanded to 0.01 (min).
    expect(r.clamped).toBe('EXPANDED');
    expect(r.rangePercent).toBeCloseTo(0.01, 8);
    expect(r.upperBand).toBeGreaterThan(r.lowerBand);
  });

  it('shrinks an oversized range to max', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 8 : -8));
    const candles = flat(closes, 0.5);
    const r = buildRange(candles, 100)!;
    expect(r.clamped).toBe('SHRUNK');
    expect(r.rangePercent).toBeCloseTo(0.04, 8);
  });
});

describe('generateLevels', () => {
  it('produces evenly spaced levels strictly inside the band', () => {
    const levels = generateLevels(99, 101, 0.0025); // ~ step = mid * 0.0025 = 0.25
    expect(levels.length).toBeGreaterThan(0);
    expect(Math.min(...levels)).toBeGreaterThan(99);
    expect(Math.max(...levels)).toBeLessThan(101);
    const diffs = levels.slice(1).map((p, i) => p - (levels[i] as number));
    for (const d of diffs) expect(d).toBeCloseTo(diffs[0] as number, 6);
  });
});

describe('detectBreakout', () => {
  it('UP breakout requires holdCandles consecutive closes past upper*pct', () => {
    const upper = 100;
    const tail = [
      { high: 0, low: 0, close: 100.6, openTime: 0 },
      { high: 0, low: 0, close: 100.7, openTime: 0 },
      { high: 0, low: 0, close: 100.8, openTime: 0 },
    ];
    const r = detectBreakout(tail, upper, 90, 0.005, 3);
    expect(r.breakout).toBe(true);
    if (r.breakout) expect(r.direction).toBe('UP');
  });

  it('no breakout if any candle within tolerance', () => {
    const tail = [
      { high: 0, low: 0, close: 100.6, openTime: 0 },
      { high: 0, low: 0, close: 100.4, openTime: 0 }, // not past 100*1.005
      { high: 0, low: 0, close: 100.7, openTime: 0 },
    ];
    expect(detectBreakout(tail, 100, 90, 0.005, 3).breakout).toBe(false);
  });

  it('DOWN breakout', () => {
    const tail = [
      { high: 0, low: 0, close: 89.4, openTime: 0 },
      { high: 0, low: 0, close: 89.3, openTime: 0 },
      { high: 0, low: 0, close: 89.2, openTime: 0 },
    ];
    const r = detectBreakout(tail, 100, 90, 0.005, 3);
    expect(r.breakout).toBe(true);
    if (r.breakout) expect(r.direction).toBe('DOWN');
  });
});

describe('countBoundaryCrosses', () => {
  it('counts upper and lower band touches separately', () => {
    const window = [
      { high: 101, low: 99.9, close: 100, openTime: 0 }, // upper touch
      { high: 100.5, low: 99.9, close: 100, openTime: 0 }, // inside
      { high: 100.5, low: 98.9, close: 100, openTime: 0 }, // lower touch
    ];
    const cr = countBoundaryCrosses(window, 100.6, 99);
    expect(cr.up).toBe(1);
    expect(cr.down).toBe(1);
    expect(cr.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Engine state machine
// ---------------------------------------------------------------------------

describe('GridEngine state machine', () => {
  function setupEngine(opts?: { candles?: Candle[]; price?: number }) {
    const exec = new MockExec();
    let candles = opts?.candles ?? flat(Array.from({ length: 30 }, () => 100), 0.5);
    let price = opts?.price ?? 100;
    const eng = new GridEngine({
      symbol: 'BTCUSDT',
      exec,
      getCurrentPrice: () => price,
      getCandles: () => candles,
    });
    return {
      exec,
      eng,
      setPrice: (p: number) => {
        price = p;
      },
      setCandles: (c: Candle[]) => {
        candles = c;
      },
    };
  }

  it('starts in RESET, then transitions to GRID after first tick', async () => {
    const { eng, exec } = setupEngine();
    expect(eng.getState()).toBe(BotState.RESET);
    await eng.tick();
    expect(eng.getState()).toBe(BotState.GRID);
    // Must have placed grid LIMIT orders.
    expect(exec.placed.filter((o) => o.purpose === 'GRID').length).toBeGreaterThan(0);
    // Mix of BUY (below price) and SELL (above price).
    const sides = new Set(exec.placed.filter((o) => o.purpose === 'GRID').map((o) => o.side));
    expect(sides.has('BUY')).toBe(true);
    expect(sides.has('SELL')).toBe(true);
  });

  it('GRID fill places a TP at the next level in profit direction', async () => {
    const { eng, exec } = setupEngine();
    await eng.tick();
    const buy = exec.placed.find((o) => o.purpose === 'GRID' && o.side === 'BUY');
    expect(buy).toBeDefined();
    await eng.onFill({
      clientOrderId: buy!.clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: buy!.qty,
      price: buy!.price as number,
      fee: 0,
      ts: Date.now(),
      purpose: 'GRID',
    });
    // A GRID_TP order must have been placed at a price > entry.
    const tp = exec.placed.find((o) => o.purpose === 'GRID_TP');
    expect(tp).toBeDefined();
    expect(tp!.side).toBe('SELL');
    expect((tp!.price as number) > (buy!.price as number)).toBe(true);
  });

  it('TP fill credits realized PnL and frees the level', async () => {
    const { eng, exec } = setupEngine();
    await eng.tick();
    const buy = exec.placed.find((o) => o.purpose === 'GRID' && o.side === 'BUY')!;
    await eng.onFill({
      clientOrderId: buy.clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: buy.qty,
      price: buy.price as number,
      fee: 0,
      ts: Date.now(),
      purpose: 'GRID',
    });
    const tp = exec.placed.find((o) => o.purpose === 'GRID_TP')!;
    await eng.onFill({
      clientOrderId: tp.clientOrderId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      qty: tp.qty,
      price: tp.price as number,
      fee: 0,
      ts: Date.now(),
      purpose: 'GRID_TP',
    });
    expect(exec.pnl.length).toBe(1);
    expect(exec.pnl[0]?.pnl).toBeGreaterThan(0);
    // No open positions on engine.
    expect(eng.snapshot().totalOpenPositions).toBe(0);
  });

  it('breakout transitions GRID → HEDGE and opens hedge sized to net exposure', async () => {
    const { eng, exec, setPrice, setCandles } = setupEngine();
    await eng.tick();
    // Force one BUY to fill so net exposure is non-zero.
    const buy = exec.placed.find((o) => o.purpose === 'GRID' && o.side === 'BUY')!;
    await eng.onFill({
      clientOrderId: buy.clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: buy.qty,
      price: buy.price as number,
      fee: 0,
      ts: Date.now(),
      purpose: 'GRID',
    });
    // Build candles that produce an UP breakout: 3 closes well above upper band.
    const snap = eng.snapshot();
    const upper = snap.upperBand;
    const breakoutPrice = upper * 1.02;
    const newCandles = [
      ...flat(Array.from({ length: 27 }, () => 100), 0.5),
      ...flat([breakoutPrice, breakoutPrice, breakoutPrice], 0.05),
    ];
    setCandles(newCandles);
    setPrice(breakoutPrice);
    await eng.tick();
    expect(eng.getState()).toBe(BotState.HEDGE);
    const hedge = exec.placed.find((o) => o.purpose === 'HEDGE');
    expect(hedge).toBeDefined();
    // Net long → hedge SHORT.
    expect(hedge!.side).toBe('SELL');
  });

  it('fake breakout returns to GRID after price re-enters range', async () => {
    const { eng, exec, setPrice, setCandles } = setupEngine();
    await eng.tick();
    const snap0 = eng.snapshot();
    const upper = snap0.upperBand;
    // Create a non-zero net via a buy fill.
    const buy = exec.placed.find((o) => o.purpose === 'GRID' && o.side === 'BUY')!;
    await eng.onFill({
      clientOrderId: buy.clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: buy.qty,
      price: buy.price as number,
      fee: 0,
      ts: Date.now(),
      purpose: 'GRID',
    });
    // Trigger UP breakout.
    const breakoutPrice = upper * 1.02;
    setCandles([
      ...flat(Array.from({ length: 27 }, () => 100), 0.5),
      ...flat([breakoutPrice, breakoutPrice, breakoutPrice], 0.05),
    ]);
    setPrice(breakoutPrice);
    await eng.tick();
    expect(eng.getState()).toBe(BotState.HEDGE);
    // Settle hedge fill so engine has a real hedge to close.
    const hedge = exec.placed.find((o) => o.purpose === 'HEDGE')!;
    await eng.onFill({
      clientOrderId: hedge.clientOrderId,
      symbol: 'BTCUSDT',
      side: hedge.side,
      qty: hedge.qty,
      price: breakoutPrice,
      fee: 0,
      ts: Date.now(),
      purpose: 'HEDGE',
    });
    // Now price returns inside range — within fakeBreakoutCandles.
    const insidePrice = (snap0.upperBand + snap0.lowerBand) / 2;
    setCandles([
      ...flat(Array.from({ length: 27 }, () => 100), 0.5),
      ...flat([breakoutPrice, breakoutPrice, breakoutPrice, insidePrice], 0.05),
    ]);
    setPrice(insidePrice);
    await eng.tick();
    expect(eng.getState()).toBe(BotState.GRID);
    const closeOrder = exec.placed.find((o) => o.purpose === 'HEDGE_CLOSE');
    expect(closeOrder).toBeDefined();
  });

  it('trend confirmed flips HEDGE → RESET', async () => {
    const { eng, exec, setPrice, setCandles } = setupEngine();
    await eng.tick();
    const snap0 = eng.snapshot();
    const upper = snap0.upperBand;
    const buy = exec.placed.find((o) => o.purpose === 'GRID' && o.side === 'BUY')!;
    await eng.onFill({
      clientOrderId: buy.clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: buy.qty,
      price: buy.price as number,
      fee: 0,
      ts: Date.now(),
      purpose: 'GRID',
    });
    const breakoutPrice = upper * 1.02;
    setCandles([
      ...flat(Array.from({ length: 27 }, () => 100), 0.5),
      ...flat([breakoutPrice, breakoutPrice, breakoutPrice], 0.05),
    ]);
    setPrice(breakoutPrice);
    await eng.tick();
    expect(eng.getState()).toBe(BotState.HEDGE);
    // Trend confirmation: extra trendConfirmPercent past breakout.
    const trendPrice = upper * 1.05;
    setPrice(trendPrice);
    await eng.tick();
    expect(eng.getState()).toBe(BotState.RESET);
    expect(eng.snapshot().cooldownRemainingMs).toBeGreaterThan(0);
  });

  it('respects per-side and total position caps', async () => {
    applySettingsPatch({
      grid: { maxOpenPositionsPerSide: 1, maxTotalPositions: 2 } as never,
    });
    const { eng, exec } = setupEngine();
    await eng.tick();
    const buys = exec.placed.filter((o) => o.purpose === 'GRID' && o.side === 'BUY');
    const sells = exec.placed.filter((o) => o.purpose === 'GRID' && o.side === 'SELL');
    // With caps of 1 per side, only 1 BUY and 1 SELL should be placed initially.
    expect(buys.length).toBe(1);
    expect(sells.length).toBe(1);
  });
});
