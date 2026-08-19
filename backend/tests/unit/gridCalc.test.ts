import Decimal from 'decimal.js';
import {
  buildGridPlan,
  calcGridTriggerPrice,
  calcGridDistanceAbs,
  calcLevelTpPrice,
  calcLevelSlPrice,
  calculatePositionAllocation,
  levelWeight,
  sizeLevelPosition,
  triangularWeight,
  traderProfitPercent,
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

describe('gridCalc — single-position directional grid', () => {
  it('triangularWeight(10) = 55', () => {
    expect(triangularWeight(10)).toBe(55);
  });

  it('reversed weights: L1=10 … L10=1', () => {
    expect(levelWeight(1, 10)).toBe(10);
    expect(levelWeight(2, 10)).toBe(9);
    expect(levelWeight(10, 10)).toBe(1);
  });

  it('Formula B: L1 = 100% capital, L2 = 90%', () => {
    expect(calculatePositionAllocation('500', 1, 10).toFixed(0)).toBe('500');
    expect(calculatePositionAllocation('500', 2, 10).toFixed(0)).toBe('450');
    expect(calculatePositionAllocation('500', 10, 10).toFixed(0)).toBe('50');
  });

  it('capital shrinks: next level uses reduced current capital', () => {
    expect(calculatePositionAllocation('470', 1, 10).toFixed(0)).toBe('470');
    expect(calculatePositionAllocation('470', 2, 10).toFixed(1)).toBe('423.0');
  });

  it('non-compounded LONG/SHORT prices from 100 @ 5%', () => {
    const start = '100';
    const long = [1, 2, 3, 4].map((L) => calcGridTriggerPrice(start, L, 'LONG', 5).toFixed(2));
    const short = [1, 2, 3, 4].map((L) => calcGridTriggerPrice(start, L, 'SHORT', 5).toFixed(2));
    expect(long).toEqual(['105.00', '110.00', '115.00', '120.00']);
    expect(short).toEqual(['95.00', '90.00', '85.00', '80.00']);
  });

  it('gridDistanceAbs = start × pct/100', () => {
    expect(calcGridDistanceAbs('100', 5).toFixed(2)).toBe('5.00');
  });

  it('TP = entry ± gridDistance; SL = start', () => {
    const dist = calcGridDistanceAbs('100', 5);
    expect(calcLevelTpPrice('105', 'LONG', dist, info)).toBe('110.00');
    expect(calcLevelTpPrice('110', 'LONG', dist, info)).toBe('115.00');
    expect(calcLevelTpPrice('95', 'SHORT', dist, info)).toBe('90.00');
    expect(calcLevelTpPrice('90', 'SHORT', dist, info)).toBe('85.00');
    expect(calcLevelSlPrice('100', info)).toBe('100.00');
  });

  it('buildGridPlan: reversed weights, 20 levels', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '500',
      leverage: 5,
      levelsPerSide: 10,
      distancePercent: 5,
      symbolInfo: info,
    });
    expect(plan.levels).toHaveLength(20);
    expect(plan.gridDistanceAbs).toBe('5.00000000');
    const long1 = plan.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(long1.weight).toBe(10);
    expect(long1.triggerPrice).toBe('105.00');
    expect(long1.tpPrice).toBe('110.00');
    expect(long1.slPrice).toBe('100.00');
    const long10 = plan.levels.find((l) => l.direction === 'LONG' && l.level === 10)!;
    expect(long10.weight).toBe(1);
  });

  it('sizeLevelPosition applies leverage once from current capital', () => {
    const sized = sizeLevelPosition({
      currentCapital: '500',
      level: 1,
      levelsPerSide: 10,
      leverage: 5,
      entryPrice: '100',
      symbolInfo: info,
    });
    // margin ≈ 500, notional ≈ 2500, qty ≈ 25
    expect(new Decimal(sized.allocatedMargin).gte(490)).toBe(true);
    expect(new Decimal(sized.notional).div(sized.allocatedMargin).toFixed(0)).toBe('5');
  });

  it('traderProfitPercent = net / allocation * 100', () => {
    expect(traderProfitPercent('50', '500').toFixed(0)).toBe('10');
  });
});
