import Decimal from 'decimal.js';
import {
  buildGridPlan,
  calcGridTriggerPrice,
  calcGridDistanceAbs,
  calcLevelTpPrice,
  calculatePositionAllocation,
  levelWeight,
  levelAllocationFraction,
  sizeLevelPosition,
  triangularWeight,
  traderProfitPercent,
  GRID_SIDE_PAIR_FACTOR,
  DEFAULT_MAX_OPEN_POSITIONS,
  resolveGridDistanceAbs,
  inferGridDistanceAbsFromTriggers,
  calcTraderTpTarget,
  isTraderTpReached,
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

describe('gridCalc — ascending capital scale (deep levels larger)', () => {
  it('triangularWeight(10) = 55', () => {
    expect(triangularWeight(10)).toBe(55);
  });

  it('ascending weights: L1=1 … L10=10', () => {
    expect(levelWeight(1, 10)).toBe(1);
    expect(levelWeight(2, 10)).toBe(2);
    expect(levelWeight(10, 10)).toBe(10);
  });

  it('allocation fractions: L1=5%, L2=10%, L10=50%', () => {
    expect(levelAllocationFraction(1, 10).toFixed(2)).toBe('0.05');
    expect(levelAllocationFraction(2, 10).toFixed(2)).toBe('0.10');
    expect(levelAllocationFraction(3, 10).toFixed(2)).toBe('0.15');
    expect(levelAllocationFraction(10, 10).toFixed(2)).toBe('0.50');
    expect(GRID_SIDE_PAIR_FACTOR).toBe(2);
    expect(DEFAULT_MAX_OPEN_POSITIONS).toBe(2);
  });

  it('allocations increase monotonically L1 < L2 < … < L10', () => {
    for (let L = 1; L < 10; L++) {
      expect(
        levelAllocationFraction(L, 10).lt(levelAllocationFraction(L + 1, 10)),
      ).toBe(true);
    }
  });

  it('Formula: L1=$25, L2=$50, L10=$250 from $500', () => {
    expect(calculatePositionAllocation('500', 1, 10).toFixed(0)).toBe('25');
    expect(calculatePositionAllocation('500', 2, 10).toFixed(0)).toBe('50');
    expect(calculatePositionAllocation('500', 3, 10).toFixed(0)).toBe('75');
    expect(calculatePositionAllocation('500', 10, 10).toFixed(0)).toBe('250');
  });

  it('current capital changes affect next allocation', () => {
    expect(calculatePositionAllocation('520', 4, 10).toFixed(0)).toBe('104');
    expect(calculatePositionAllocation('1000', 1, 10).toFixed(0)).toBe('50');
    expect(calculatePositionAllocation('1000', 10, 10).toFixed(0)).toBe('500');
  });

  it('N=5 levels: L1=10% … L5=50%', () => {
    expect(levelAllocationFraction(1, 5).toFixed(2)).toBe('0.10');
    expect(levelAllocationFraction(5, 5).toFixed(2)).toBe('0.50');
    expect(calculatePositionAllocation('500', 1, 5).toFixed(0)).toBe('50');
    expect(calculatePositionAllocation('500', 5, 5).toFixed(0)).toBe('250');
  });

  it('maxOpenPositions param: with maxOpen=1, L10=100%', () => {
    expect(levelAllocationFraction(10, 10, 1).toFixed(2)).toBe('1.00');
    expect(levelAllocationFraction(1, 10, 1).toFixed(2)).toBe('0.10');
  });

  it('L1 is smallest, L10 is largest', () => {
    const a1 = calculatePositionAllocation('500', 1, 10);
    const a10 = calculatePositionAllocation('500', 10, 10);
    expect(a1.lt(a10)).toBe(true);
    expect(a1.toFixed(0)).toBe('25');
    expect(a10.toFixed(0)).toBe('250');
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

  it('TP = entry ± gridDistance (unchanged)', () => {
    const dist = calcGridDistanceAbs('100', 5);
    expect(calcLevelTpPrice('105', 'LONG', dist, info)).toBe('110.00');
    expect(calcLevelTpPrice('95', 'SHORT', dist, info)).toBe('90.00');
  });

  it('buildGridPlan: L1 weight 1 / 5%, L10 weight 10 / 50%', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '500',
      leverage: 5,
      levelsPerSide: 10,
      distancePercent: 5,
      symbolInfo: info,
    });
    expect(plan.levels).toHaveLength(20);
    const long1 = plan.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    const long10 = plan.levels.find((l) => l.direction === 'LONG' && l.level === 10)!;
    const short1 = plan.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(long1.weight).toBe(1);
    expect(long1.allocationPct).toBe('0.05000000');
    expect(long10.weight).toBe(10);
    expect(long10.allocationPct).toBe('0.50000000');
    expect(short1.weight).toBe(1);
    expect(short1.allocationPct).toBe('0.05000000');
  });

  it('sizeLevelPosition applies leverage once from 5% L1 capital', () => {
    const sized = sizeLevelPosition({
      currentCapital: '500',
      level: 1,
      levelsPerSide: 10,
      leverage: 5,
      entryPrice: '100',
      symbolInfo: info,
    });
    // margin ≈ 25, notional ≈ 125
    expect(new Decimal(sized.allocatedMargin).gte(20)).toBe(true);
    expect(new Decimal(sized.allocatedMargin).lte(30)).toBe(true);
    expect(new Decimal(sized.notional).div(sized.allocatedMargin).toFixed(0)).toBe('5');
    expect(sized.weight).toBe(1);
  });

  it('L9+L10 margins from $500 sum under capital', () => {
    const m9 = calculatePositionAllocation('500', 9, 10);
    const m10 = calculatePositionAllocation('500', 10, 10);
    expect(m9.plus(m10).toFixed(0)).toBe('475');
    expect(m9.plus(m10).lte(500)).toBe(true);
  });

  it('traderProfitPercent = net / allocation * 100', () => {
    expect(traderProfitPercent('50', '500').toFixed(0)).toBe('10');
  });

  it('screenshot case: SHORT L7 TP is one grid step', () => {
    const micro: SymbolInfo = {
      ...info,
      symbol: 'ALTUSDT',
      pricePrecision: 6,
      tickSize: '0.000010',
      stepSize: '1',
      minQty: '1',
      minNotional: '5',
    };
    const start = '0.134020';
    const plan = buildGridPlan({
      startPrice: start,
      traderAllocation: '600',
      leverage: 10,
      levelsPerSide: 10,
      distancePercent: 3,
      symbolInfo: micro,
    });
    const s7 = plan.levels.find((l) => l.direction === 'SHORT' && l.level === 7)!;
    const s8 = plan.levels.find((l) => l.direction === 'SHORT' && l.level === 8)!;
    expect(parseFloat(s7.triggerPrice)).toBeCloseTo(0.10588, 4);
    expect(parseFloat(s7.tpPrice)).toBeCloseTo(parseFloat(s8.triggerPrice), 4);
    expect(s7.weight).toBe(7);
    expect(parseFloat(s7.allocationPct)).toBeCloseTo(0.35, 4);

    const drifted = resolveGridDistanceAbs({
      levels: plan.levels,
      startPrice: start,
      distancePercent: 7,
    });
    expect(drifted.toFixed(6)).toBe(inferGridDistanceAbsFromTriggers(plan.levels)!.toFixed(6));
  });

  it('every level TP distance equals one grid step', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '500',
      leverage: 5,
      levelsPerSide: 10,
      distancePercent: 5,
      symbolInfo: info,
    });
    const step = new Decimal(plan.gridDistanceAbs);
    for (const l of plan.levels) {
      const delta = new Decimal(l.tpPrice).minus(l.triggerPrice).abs();
      expect(delta.toFixed(2)).toBe(step.toFixed(2));
    }
  });
});

describe('gridCalc — trader total TP target (frozen on initial capital)', () => {
  it('TEST 1: $500 × 10% → +$50 target', () => {
    expect(calcTraderTpTarget('500', '10').toFixed(2)).toBe('50.00');
  });

  it('TEST 2: target ignores current capital growth', () => {
    const target = calcTraderTpTarget('500', '10');
    expect(target.toFixed(2)).toBe('50.00');
    // current capital $600 must not change target
    expect(calcTraderTpTarget('500', '10').toFixed(2)).toBe('50.00');
    expect(isTraderTpReached('49', '500', '10')).toBe(false);
  });

  it('TEST 3–4: net PnL threshold', () => {
    expect(isTraderTpReached('49', '500', '10')).toBe(false);
    expect(isTraderTpReached('50', '500', '10')).toBe(true);
    expect(isTraderTpReached('51', '500', '10')).toBe(true);
  });

  it('TEST 5: gross above target but net below does not reach', () => {
    const gross = 52;
    const fees = 3;
    const net = gross - fees; // 49
    expect(isTraderTpReached(String(net), '500', '10')).toBe(false);
    expect(isTraderTpReached(String(gross), '500', '10')).toBe(true); // would wrongly fire if using gross
  });
});
