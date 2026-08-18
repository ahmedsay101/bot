import Decimal from 'decimal.js';
import {
  buildGridPlan,
  calcGridTriggerPrice,
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

describe('gridCalc — directional grid', () => {
  it('triangularWeight(10) = 55', () => {
    expect(triangularWeight(10)).toBe(55);
  });

  it('non-compounded LONG/SHORT prices from 100 @ 5%', () => {
    const start = '100';
    const long = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((L) =>
      calcGridTriggerPrice(start, L, 'LONG', 5).toFixed(2),
    );
    const short = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((L) =>
      calcGridTriggerPrice(start, L, 'SHORT', 5).toFixed(2),
    );
    expect(long).toEqual(['105.00', '110.00', '115.00', '120.00', '125.00', '130.00', '135.00', '140.00', '145.00', '150.00']);
    expect(short).toEqual(['95.00', '90.00', '85.00', '80.00', '75.00', '70.00', '65.00', '60.00', '55.00', '50.00']);
    // Not compounded: L2 is 110 not 110.25
    expect(calcGridTriggerPrice(start, 2, 'LONG', 5).toFixed(2)).toBe('110.00');
  });

  it('buildGridPlan: 20 levels, total weight 110, margin ≤ allocation', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '100',
      leverage: 5,
      levelsPerSide: 10,
      distancePercent: 5,
      symbolInfo: info,
    });
    expect(plan.levels).toHaveLength(20);
    expect(plan.totalWeight).toBe(110);
    expect(plan.levels.filter((l) => l.direction === 'LONG')).toHaveLength(10);
    expect(plan.levels.filter((l) => l.direction === 'SHORT')).toHaveLength(10);
    expect(new Decimal(plan.totalAllocatedMargin).lte(100)).toBe(true);
    // Level weights 1..10
    for (let i = 1; i <= 10; i++) {
      expect(plan.levels.find((l) => l.direction === 'LONG' && l.level === i)?.weight).toBe(i);
    }
    const long1 = plan.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(long1.triggerPrice).toBe('105.00');
    expect(new Decimal(long1.quantity).gt(0)).toBe(true);
  });

  it('traderProfitPercent = net / allocation * 100', () => {
    expect(traderProfitPercent('10', '100').toFixed(2)).toBe('10.00');
    expect(traderProfitPercent('5', '500').toFixed(2)).toBe('1.00');
  });
});
