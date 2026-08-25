/**
 * Grid capital: MODE A triangular scaling vs MODE B equal allocation.
 */
import Decimal from 'decimal.js';
import {
  buildGridPlan,
  calcGridTriggerPrice,
  calcGridDistanceAbs,
  calculatePositionAllocation,
  equalCapitalPerLevel,
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
  isPastFinalLongLevel,
  isPastFinalShortLevel,
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

describe('gridCalc — MODE B scaling OFF (equal allocation, multi-position)', () => {
  it('TEST 1/2: $500 / 40 levels → $12.50 margin, $125 notional at 10x', () => {
    const sized = sizeLevelPosition({
      traderAllocation: '500',
      level: 1,
      levelsPerSide: 20,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(parseFloat(sized.allocatedMargin)).toBeCloseTo(12.5, 4);
    expect(parseFloat(sized.notional)).toBeCloseTo(125, 2);
  });

  it('TEST 3: all LONG and SHORT levels have identical margin', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '500',
      leverage: 10,
      levelsPerSide: 20,
      distancePercent: 1,
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(plan.totalLevels).toBe(40);
    expect(plan.maxActivePositions).toBe(40);
    expect(parseFloat(plan.capitalPerLevel)).toBeCloseTo(12.5, 4);
    for (const l of plan.levels) {
      expect(parseFloat(l.theoreticalMargin)).toBeCloseTo(12.5, 4);
    }
  });

  it('level number does not change margin when OFF', () => {
    const a = sizeLevelPosition({
      traderAllocation: '1000',
      level: 1,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    const b = sizeLevelPosition({
      traderAllocation: '1000',
      level: 10,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(a.allocatedMargin).toBe(b.allocatedMargin);
    expect(parseFloat(a.allocatedMargin)).toBeCloseTo(50, 4); // 1000/20
  });

  it('grid size changes equal margin (denominator = 2N)', () => {
    const a = sizeLevelPosition({
      traderAllocation: '500',
      level: 1,
      levelsPerSide: 3,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    const b = sizeLevelPosition({
      traderAllocation: '500',
      level: 1,
      levelsPerSide: 10,
      leverage: 10,
      entryPrice: '100',
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    expect(parseFloat(a.allocatedMargin)).toBeCloseTo(500 / 6, 2);
    expect(parseFloat(b.allocatedMargin)).toBeCloseTo(25, 2);
  });

  it('buildGridPlan OFF: equal capitalPerLevel; maxActive = totalLevels', () => {
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
    expect(plan.maxActivePositions).toBe(20);
    expect(parseFloat(plan.capitalPerLevel)).toBeCloseTo(50, 4);
    for (const l of plan.levels) {
      expect(parseFloat(l.theoreticalMargin)).toBeCloseTo(50, 4);
      expect(parseFloat(l.allocationPct)).toBeCloseTo(1 / 20, 6);
    }
  });

  it('calculatePositionAllocation OFF returns equal slice', () => {
    expect(calculatePositionAllocation('500', 5, 20, false).toFixed(2)).toBe('12.50');
  });

  it('TEST 11/12: equalCapitalPerLevel ignores dead-level count (denominator fixed)', () => {
    expect(equalCapitalPerLevel('500', 20).toFixed(2)).toBe('12.50');
    // Still /40 even if caller imagines 10 dead — API has no dead param by design
    expect(equalCapitalPerLevel('500', 20).toFixed(2)).toBe('12.50');
  });
});

describe('gridCalc — flipped orientation (LONG below / SHORT above)', () => {
  it('start=100 spacing=5%: LONG below, SHORT above', () => {
    expect(calcGridTriggerPrice('100', 1, 'LONG', 5).toFixed(2)).toBe('95.00');
    expect(calcGridTriggerPrice('100', 2, 'LONG', 5).toFixed(2)).toBe('90.00');
    expect(calcGridTriggerPrice('100', 1, 'SHORT', 5).toFixed(2)).toBe('105.00');
    expect(calcGridTriggerPrice('100', 2, 'SHORT', 5).toFixed(2)).toBe('110.00');
  });

  it('buildGridPlan: LONG entries < start < SHORT entries; TP only (sl null)', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '1000',
      leverage: 10,
      levelsPerSide: 3,
      distancePercent: 5,
      symbolInfo: info,
      capitalScalingEnabled: false,
    });
    const longs = plan.levels.filter((l) => l.direction === 'LONG').sort((a, b) => a.level - b.level);
    const shorts = plan.levels.filter((l) => l.direction === 'SHORT').sort((a, b) => a.level - b.level);
    expect(parseFloat(longs[0]!.triggerPrice)).toBeLessThan(100);
    expect(parseFloat(longs[1]!.triggerPrice)).toBeLessThan(parseFloat(longs[0]!.triggerPrice));
    expect(parseFloat(shorts[0]!.triggerPrice)).toBeGreaterThan(100);
    expect(parseFloat(shorts[1]!.triggerPrice)).toBeGreaterThan(parseFloat(shorts[0]!.triggerPrice));
    for (const l of plan.levels) {
      const entry = parseFloat(l.triggerPrice);
      const tp = parseFloat(l.tpPrice);
      expect(l.slPrice).toBeNull();
      if (l.direction === 'LONG') {
        expect(tp).toBeGreaterThan(entry);
      } else {
        expect(tp).toBeLessThan(entry);
      }
    }
  });
});

describe('gridCalc — TP only from spacing % (no SL)', () => {
  it('LONG 1%: TP correct, slPrice null', () => {
    const { tpPrice, slPrice } = calcLevelTpSlPrices('100', 'LONG', '1', info);
    expect(parseFloat(tpPrice)).toBeCloseTo(101, 2);
    expect(slPrice).toBeNull();
  });

  it('SHORT 1%: TP correct, slPrice null', () => {
    const { tpPrice, slPrice } = calcLevelTpSlPrices('100', 'SHORT', '1', info);
    expect(parseFloat(tpPrice)).toBeCloseTo(99, 2);
    expect(slPrice).toBeNull();
  });

  it('2% and 5% TP only', () => {
    expect(parseFloat(calcLevelTpSlPrices('100', 'LONG', '2', info).tpPrice)).toBeCloseTo(102, 2);
    expect(calcLevelTpSlPrices('100', 'LONG', '5', info).slPrice).toBeNull();
    expect(parseFloat(calcLevelTpSlPrices('100', 'LONG', '5', info).tpPrice)).toBeCloseTo(105, 2);
    expect(parseFloat(calcLevelTpSlPrices('100', 'SHORT', '5', info).tpPrice)).toBeCloseTo(95, 2);
  });
});

describe('allGridLevelsHitTp', () => {
  it('SL does not count as TP', () => {
    expect(allGridLevelsHitTp(['TP_HIT', 'TP_HIT'])).toBe(true);
    expect(allGridLevelsHitTp(['TP_HIT', 'SL_HIT'])).toBe(false);
  });
});

describe('misc', () => {
  it('triggers and exhaustion helpers', () => {
    expect(calcGridTriggerPrice('100', 1, 'LONG', 5).toFixed(2)).toBe('95.00');
    expect(calcGridDistanceAbs('100', 5).toFixed(2)).toBe('5.00');
    expect(levelWeight(1, 10, true)).toBe(1);
    expect(totalGridLevels(10)).toBe(20);
    expect(getUpperGridExhaustionPrice('110', '1').toFixed(2)).toBe('111.10');
    expect(getLowerGridExhaustionPrice('90', '1').toFixed(2)).toBe('89.10');
  });
});

describe('gridCalc — final grid boundary (strict past)', () => {
  it('isPastFinalLongLevel: mark < lastLong only', () => {
    expect(isPastFinalLongLevel('89', '90')).toBe(true);
    expect(isPastFinalLongLevel('90', '90')).toBe(false);
    expect(isPastFinalLongLevel('91', '90')).toBe(false);
  });

  it('isPastFinalShortLevel: mark > lastShort only', () => {
    expect(isPastFinalShortLevel('111', '110')).toBe(true);
    expect(isPastFinalShortLevel('110', '110')).toBe(false);
    expect(isPastFinalShortLevel('109', '110')).toBe(false);
  });
});

describe('gridCalc — entry / TP crossing (gap-safe, flipped)', () => {
  it('LONG entry: downward cross / mark at or below trigger', () => {
    expect(isEntryTriggered('LONG', '94', '95')).toBe(true);
    expect(isEntryTriggered('LONG', '96', '95')).toBe(false);
    expect(didCrossEntry('LONG', '96', '94', '95')).toBe(true);
    expect(didCrossEntry('LONG', '94', '93', '95')).toBe(false); // already through
  });

  it('SHORT entry: upward cross / mark at or above trigger', () => {
    expect(isEntryTriggered('SHORT', '106', '105')).toBe(true);
    expect(isEntryTriggered('SHORT', '104', '105')).toBe(false);
    expect(didCrossEntry('SHORT', '104', '106', '105')).toBe(true);
  });

  it('price moving up does not activate LONG; down does not activate SHORT', () => {
    expect(isEntryTriggered('LONG', '106', '95')).toBe(false);
    expect(isEntryTriggered('SHORT', '94', '105')).toBe(false);
    expect(findTriggeredPendingLevels(
      [{ direction: 'LONG' as const, status: 'PENDING', triggerPrice: '95', level: 1 }],
      '106',
      '100',
    )).toHaveLength(0);
    expect(findTriggeredPendingLevels(
      [{ direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '105', level: 1 }],
      '94',
      '100',
    )).toHaveLength(0);
  });

  it('detects multiple LONG levels crossed in one downward jump', () => {
    const levels = [
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '95', level: 1 },
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '90', level: 2 },
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '85', level: 3 },
      { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '80', level: 4 },
    ];
    const hit = findTriggeredPendingLevels(levels, '88', '100');
    expect(hit.map((l) => l.level)).toEqual([1, 2]);
  });

  it('Test A: previous 100 → current 95 crosses LONG 97', () => {
    expect(didCrossEntry('LONG', '100', '95', '97')).toBe(true);
    expect(isEntryTriggered('LONG', '95', '97')).toBe(true);
  });

  it('Test B: previous 100 → current 80 crosses LONG 95/90/85', () => {
    expect(didCrossEntry('LONG', '100', '80', '95')).toBe(true);
    expect(didCrossEntry('LONG', '100', '80', '90')).toBe(true);
    expect(didCrossEntry('LONG', '100', '80', '85')).toBe(true);
    const hit = findTriggeredPendingLevels(
      [
        { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '95', level: 1 },
        { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '90', level: 2 },
        { direction: 'LONG' as const, status: 'PENDING', triggerPrice: '85', level: 3 },
      ],
      '80',
      '100',
    );
    expect(hit.map((l) => l.level)).toEqual([1, 2, 3]);
  });

  it('Test C: previous 80 → current 100 crosses SHORT 85/90/95', () => {
    expect(didCrossEntry('SHORT', '80', '100', '85')).toBe(true);
    expect(didCrossEntry('SHORT', '80', '100', '90')).toBe(true);
    expect(didCrossEntry('SHORT', '80', '100', '95')).toBe(true);
    const hit = findTriggeredPendingLevels(
      [
        { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '85', level: 1 },
        { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '90', level: 2 },
        { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '95', level: 3 },
      ],
      '100',
      '80',
    );
    expect(hit.map((l) => l.level)).toEqual([1, 2, 3]);
  });

  it('detects multiple SHORT levels crossed upward', () => {
    const levels = [
      { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '105', level: 1 },
      { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '110', level: 2 },
      { direction: 'SHORT' as const, status: 'PENDING', triggerPrice: '115', level: 3 },
    ];
    const hit = findTriggeredPendingLevels(levels, '112', '100');
    expect(hit.map((l) => l.level)).toEqual([1, 2]);
  });

  it('LONG TP by mark without exact equality', () => {
    expect(isTpTriggeredByMark('LONG', '110.5', '110')).toBe(true);
    expect(isTpTriggeredByMark('LONG', '109.9', '110')).toBe(false);
  });

  it('SHORT TP by mark — gaps and already-past', () => {
    expect(isTpTriggeredByMark('SHORT', '90', '95')).toBe(true);
    expect(isTpTriggeredByMark('SHORT', '95', '95')).toBe(true);
    expect(isTpTriggeredByMark('SHORT', '96', '95')).toBe(false);
  });
});
