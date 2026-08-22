/**
 * Hold-to-exhaustion grid unit tests — side pools + L/triangular(N).
 */
import Decimal from 'decimal.js';
import {
  buildGridPlan,
  calcGridTriggerPrice,
  calcGridDistanceAbs,
  calculatePositionAllocation,
  levelWeight,
  levelAllocationFraction,
  sizeLevelPosition,
  triangularWeight,
  sideCapitalFromTrader,
  resolveGridDistanceAbs,
  inferGridDistanceAbsFromTriggers,
} from '../../src/modules/trader/grid/gridCalc';
import type { SymbolInfo } from '../../src/types';

const info: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  pricePrecision: 2,
  quantityPrecision: 3,
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  minNotional: '1',
  maxLeverage: 125,
  contractType: 'PERPETUAL',
  status: 'TRADING',
};

describe('gridCalc — side pools + triangular normalization', () => {
  it('triangularWeight(10) = 55', () => {
    expect(triangularWeight(10)).toBe(55);
  });

  it('$1000 trader → LONG $500 SHORT $500', () => {
    expect(sideCapitalFromTrader('1000').toFixed(2)).toBe('500.00');
  });

  it('fractions L1=1/55 … L10=10/55', () => {
    expect(levelAllocationFraction(1, 10).toFixed(8)).toBe((1 / 55).toFixed(8));
    expect(levelAllocationFraction(10, 10).toFixed(8)).toBe((10 / 55).toFixed(8));
  });

  it('sum of side margins = side capital ($500)', () => {
    const side = new Decimal(500);
    let sum = new Decimal(0);
    for (let L = 1; L <= 10; L++) {
      sum = sum.plus(calculatePositionAllocation(side, L, 10));
    }
    expect(sum.toFixed(6)).toBe('500.000000');
  });

  it('buildGridPlan: both sides sum to trader allocation', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '1000',
      leverage: 10,
      levelsPerSide: 10,
      distancePercent: 5,
      symbolInfo: info,
    });
    expect(plan.longSideCapital).toBe('500.00000000');
    expect(plan.shortSideCapital).toBe('500.00000000');
    let longSum = new Decimal(0);
    let shortSum = new Decimal(0);
    for (const l of plan.levels) {
      const m = new Decimal(l.theoreticalMargin);
      if (l.direction === 'LONG') longSum = longSum.plus(m);
      else shortSum = shortSum.plus(m);
    }
    expect(longSum.toFixed(4)).toBe('500.0000');
    expect(shortSum.toFixed(4)).toBe('500.0000');
    const l1 = plan.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    const l10 = plan.levels.find((l) => l.direction === 'LONG' && l.level === 10)!;
    expect(l1.weight).toBe(1);
    expect(l10.weight).toBe(10);
    expect(parseFloat(l1.theoreticalMargin)).toBeLessThan(parseFloat(l10.theoreticalMargin));
    expect(l1.tpPrice).toBe('');
  });

  it('leverage applied once: $100 margin → $1000 notional at 10x', () => {
    const sized = sizeLevelPosition({
      sideCapital: '550', // L10 = 10/55 * 550 = 100
      level: 10,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
    });
    expect(parseFloat(sized.allocatedMargin)).toBeCloseTo(100, 0);
    expect(parseFloat(sized.notional)).toBeCloseTo(1000, 0);
  });

  it('grid triggers unchanged', () => {
    expect(calcGridTriggerPrice('100', 1, 'LONG', 5).toFixed(2)).toBe('105.00');
    expect(calcGridTriggerPrice('100', 1, 'SHORT', 5).toFixed(2)).toBe('95.00');
    expect(calcGridDistanceAbs('100', 5).toFixed(2)).toBe('5.00');
  });

  it('ascending weights', () => {
    expect(levelWeight(1, 10)).toBe(1);
    expect(levelWeight(10, 10)).toBe(10);
  });
});
