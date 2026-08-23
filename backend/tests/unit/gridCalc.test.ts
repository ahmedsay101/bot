/**
 * Grid capital: MODE A triangular scaling vs MODE B 100% current capital.
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
  calcLevelTpSlPrices,
  allGridLevelsHitTp,
  totalGridLevels,
  getUpperGridExhaustionPrice,
  getLowerGridExhaustionPrice,
  isEntryTriggered,
  didCrossEntry,
  findTriggeredPendingLevels,
  isTpTriggeredByMark,
  isSlTriggeredByMark,
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

describe('gridCalc — MODE A scaled (triangular) capital — UNCHANGED', () => {
  it('triangularWeight(10) = 55', () => {
    expect(triangularWeight(10)).toBe(55);
  });

  it('$1000 trader → LONG $500 SHORT $500', () => {
    expect(sideCapitalFromTrader('1000').toFixed(2)).toBe('500.00');
  });

  it('fractions L1=1/55 … L10=10/55', () => {
    expect(levelAllocationFraction(1, 10, true).toFixed(8)).toBe((1 / 55).toFixed(8));
    expect(levelAllocationFraction(10, 10, true).toFixed(8)).toBe((10 / 55).toFixed(8));
  });

  it('sum of side margins = side capital ($500)', () => {
    const side = new Decimal(500);
    let sum = new Decimal(0);
    for (let L = 1; L <= 10; L++) {
      sum = sum.plus(calculatePositionAllocation(side, L, 10, true));
    }
    expect(sum.toFixed(6)).toBe('500.000000');
  });

  it('buildGridPlan scaled: both sides sum to trader allocation', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '1000',
      leverage: 10,
      levelsPerSide: 10,
      distancePercent: 5,
      symbolInfo: info,
      capitalScalingEnabled: true,
    });
    expect(plan.capitalScalingEnabled).toBe(true);
    expect(plan.maxActivePositions).toBe(20);
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
    expect(parseFloat(l1.theoreticalMargin)).toBeLessThan(parseFloat(l10.theoreticalMargin));
  });

  it('leverage after margin: $100 → $1000 notional at 10x', () => {
    const sized = sizeLevelPosition({
      sideCapital: '550',
      level: 10,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: true,
    });
    expect(parseFloat(sized.allocatedMargin)).toBeCloseTo(100, 0);
    expect(parseFloat(sized.notional)).toBeCloseTo(1000, 0);
  });
});

describe('gridCalc — MODE B scaling OFF (100% current capital)', () => {
  it('margin = currentTraderCapital, NOT capital÷levels', () => {
    const sized = sizeLevelPosition({
      currentTraderCapital: '1000',
      level: 1,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(parseFloat(sized.allocatedMargin)).toBeCloseTo(1000, 0);
    expect(parseFloat(sized.notional)).toBeCloseTo(10000, 0);
    expect(sized.allocationPct).toBe('1.00000000');
  });

  it('level number does not change margin when OFF', () => {
    const a = sizeLevelPosition({
      currentTraderCapital: '1000',
      level: 1,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    const b = sizeLevelPosition({
      currentTraderCapital: '1000',
      level: 10,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(a.allocatedMargin).toBe(b.allocatedMargin);
  });

  it('grid size does not affect OFF margin', () => {
    const a = sizeLevelPosition({
      currentTraderCapital: '500',
      level: 1,
      levelsPerSide: 3,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    const b = sizeLevelPosition({
      currentTraderCapital: '500',
      level: 1,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(parseFloat(a.allocatedMargin)).toBeCloseTo(500, 0);
    expect(parseFloat(b.allocatedMargin)).toBeCloseTo(500, 0);
    expect(parseFloat(a.notional)).toBeCloseTo(5000, 0);
  });

  it('buildGridPlan OFF: theoretical = full capital; maxActive=1', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '1000',
      leverage: 10,
      levelsPerSide: 10,
      distancePercent: 1,
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(plan.capitalScalingEnabled).toBe(false);
    expect(plan.maxActivePositions).toBe(1);
    expect(plan.capitalPerLevel).toBe('1000.00000000');
    for (const l of plan.levels) {
      expect(l.theoreticalMargin).toBe('1000.00000000');
      expect(l.allocationPct).toBe('1.00000000');
    }
  });

  it('calculatePositionAllocation OFF returns full pool', () => {
    expect(calculatePositionAllocation('1000', 5, 10, false).toFixed(2)).toBe('1000.00');
  });
});

describe('gridCalc — TP/SL from spacing %', () => {
  it('LONG 1%', () => {
    const { tpPrice, slPrice } = calcLevelTpSlPrices('100', 'LONG', '1', info);
    expect(parseFloat(tpPrice)).toBeCloseTo(101, 2);
    expect(parseFloat(slPrice)).toBeCloseTo(99, 2);
  });

  it('SHORT 1%', () => {
    const { tpPrice, slPrice } = calcLevelTpSlPrices('100', 'SHORT', '1', info);
    expect(parseFloat(tpPrice)).toBeCloseTo(99, 2);
    expect(parseFloat(slPrice)).toBeCloseTo(101, 2);
  });

  it('2% and 5%', () => {
    expect(parseFloat(calcLevelTpSlPrices('100', 'LONG', '2', info).tpPrice)).toBeCloseTo(102, 2);
    expect(parseFloat(calcLevelTpSlPrices('100', 'LONG', '5', info).slPrice)).toBeCloseTo(95, 2);
  });
});

describe('allGridLevelsHitTp', () => {
  it('SL does not count as TP', () => {
    expect(allGridLevelsHitTp(['TP_HIT', 'TP_HIT'])).toBe(true);
    expect(allGridLevelsHitTp(['TP_HIT', 'SL_HIT'])).toBe(false);
  });
});

describe('misc', () => {
  it('triggers', () => {
    expect(calcGridTriggerPrice('100', 1, 'LONG', 5).toFixed(2)).toBe('105.00');
    expect(calcGridDistanceAbs('100', 5).toFixed(2)).toBe('5.00');
    expect(levelWeight(1, 10, true)).toBe(1);
    expect(totalGridLevels(10)).toBe(20);
    expect(getUpperGridExhaustionPrice('110', '1').toFixed(2)).toBe('111.10');
    expect(getLowerGridExhaustionPrice('90', '1').toFixed(2)).toBe('89.10');
  });
});

describe('gridCalc — entry / TP / SL crossing (gap-safe)', () => {
  it('LONG entry: gap from below to above without exact hit', () => {
    expect(isEntryTriggered('LONG', '0.0645', '0.06379')).toBe(true);
    expect(didCrossEntry('LONG', '0.0635', '0.0645', '0.06379')).toBe(true);
    expect(didCrossEntry('LONG', '0.0645', '0.0650', '0.06379')).toBe(false); // already above
  });

  it('detects multiple LONG levels crossed in one jump', () => {
    const levels = [
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '0.063790', level: 1 },
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '0.064420', level: 2 },
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '0.065050', level: 3 },
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '0.065690', level: 4 },
    ];
    const hit = findTriggeredPendingLevels(levels, '0.065500', '0.063160');
    expect(hit.map((l) => l.level)).toEqual([1, 2, 3]);
  });

  it('detects multiple SHORT levels crossed downward', () => {
    const levels = [
      { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '98', level: 1 },
      { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '95', level: 2 },
      { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '92', level: 3 },
    ];
    const hit = findTriggeredPendingLevels(levels, '90', '100');
    expect(hit.map((l) => l.level)).toEqual([1, 2, 3]);
  });

  it('LONG TP/SL by mark without exact equality', () => {
    expect(isTpTriggeredByMark('LONG', '110.5', '110')).toBe(true);
    expect(isSlTriggeredByMark('LONG', '89', '90')).toBe(true);
  });

  it('SHORT TP/SL by mark — SL above entry when mark jumps past', () => {
    expect(isTpTriggeredByMark('SHORT', '90', '95')).toBe(true);
    expect(isSlTriggeredByMark('SHORT', '0.065500', '0.063100')).toBe(true);
    expect(isSlTriggeredByMark('SHORT', '0.062900', '0.063100')).toBe(false);
  });
});
