import {
  levelsPerSideFromConfig,
  calcUpperBound,
  calcLowerBound,
  isPastUpperBound,
  isPastLowerBound,
  didCrossOutsideBoundary,
  calcLevelPrice,
  distancePercentFromLevel,
  isWithinActivationZone,
  assignSideForLevel,
  buildNearPriceLevelPlans,
  findEligibleEmptyLevels,
  calcNearPriceTp,
  calcStopLimitPrices,
  activationDistancePercent,
  isNearPriceLevelTerminal,
  resetLevelAfterTpClose,
  selectNearestTargetLevels,
  resolveDesiredNearPriceGrid,
  nearestGridLevelsByMark,
  didCrossTakeProfit,
  didCrossStopTrigger,
  NEAR_PRICE_MAX_PER_SIDE,
} from '../../src/modules/trader/near-price/nearPriceGridCalc';
import { isTpTriggeredByMark } from '../../src/modules/trader/grid/gridCalc';
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
  minNotional: '5',
  maxLeverage: 125,
  contractType: 'PERPETUAL',
  status: 'TRADING',
};

describe('nearPriceGridCalc', () => {
  it('levelsPerSide = floor(boundary / spacing)', () => {
    expect(levelsPerSideFromConfig(40, 2)).toBe(20);
    expect(levelsPerSideFromConfig('40', '2')).toBe(20);
  });

  it('bounds: start 100, boundary 40% → 60 / 140', () => {
    expect(calcLowerBound('100', 40).toFixed(2)).toBe('60.00');
    expect(calcUpperBound('100', 40).toFixed(2)).toBe('140.00');
  });

  it('boundary destroy: strict past only; gaps detected', () => {
    expect(isPastUpperBound('140', '140')).toBe(false);
    expect(isPastUpperBound('140.01', '140')).toBe(true);
    expect(isPastLowerBound('60', '60')).toBe(false);
    expect(isPastLowerBound('59.99', '60')).toBe(true);
    expect(didCrossOutsideBoundary('135', '145', '60', '140')).toBe(true);
    expect(didCrossOutsideBoundary('65', '55', '60', '140')).toBe(true);
    expect(didCrossOutsideBoundary('100', '100', '60', '140')).toBe(false);
  });

  it('level prices with 2% spacing from 100', () => {
    expect(calcLevelPrice('100', 1, 'ABOVE', 2).toFixed(2)).toBe('102.00');
    expect(calcLevelPrice('100', 2, 'ABOVE', 2).toFixed(2)).toBe('104.00');
    expect(calcLevelPrice('100', 1, 'BELOW', 2).toFixed(2)).toBe('98.00');
    expect(calcLevelPrice('100', 2, 'BELOW', 2).toFixed(2)).toBe('96.00');
  });

  it('TEST 1: mark below level → LONG', () => {
    expect(assignSideForLevel('100', '102')).toBe('LONG');
  });

  it('TEST 2: mark above level → SHORT', () => {
    expect(assignSideForLevel('100', '98')).toBe('SHORT');
  });

  it('TEST 3: mark exactly at level → SHORT (deterministic)', () => {
    expect(assignSideForLevel('100', '100')).toBe('SHORT');
  });

  it('TEST 4/5: activation threshold at 4%', () => {
    // |106-110|/110 ≈ 3.636% ≤ 4% → inside
    expect(isWithinActivationZone('106', '110', 2, 2)).toBe(true);
    // |105-110|/110 ≈ 4.545% > 4% → outside
    expect(isWithinActivationZone('105', '110', 2, 2)).toBe(false);
    expect(activationDistancePercent(2, 2).toFixed(0)).toBe('4');
  });

  it('distance uses level as reference', () => {
    expect(distancePercentFromLevel('106', '110').toFixed(4)).toBe('3.6364');
  });

  it('build plan: 40 levels for 40%/2%', () => {
    const plans = buildNearPriceLevelPlans({
      startPrice: '100',
      boundaryPercent: 40,
      spacingPercent: 2,
      symbolInfo: info,
    });
    expect(plans).toHaveLength(40);
    expect(plans.every((p) => p.status === 'EMPTY')).toBe(true);
    const prices = plans.map((p) => parseFloat(p.levelPrice));
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...prices)).toBeLessThanOrEqual(140);
    // no start price as a level
    expect(prices.includes(100)).toBe(false);
  });

  it('eligible at mark=100: 102/104 LONG, 98 SHORT; 96 outside 4% (level-ref)', () => {
    const plans = buildNearPriceLevelPlans({
      startPrice: '100',
      boundaryPercent: 40,
      spacingPercent: 2,
      symbolInfo: info,
    });
    const eligible = findEligibleEmptyLevels(plans, '100', 2, 2);
    const sides = eligible.map((e) => ({
      price: parseFloat(e.levelPrice),
      side: assignSideForLevel('100', e.levelPrice),
    }));
    expect(sides.find((s) => s.price === 102)?.side).toBe('LONG');
    expect(sides.find((s) => s.price === 104)?.side).toBe('LONG');
    expect(sides.find((s) => s.price === 98)?.side).toBe('SHORT');
    // |100-96|/96 ≈ 4.17% > 4% activation → not eligible (level-price reference)
    expect(sides.find((s) => s.price === 96)).toBeUndefined();
    expect(eligible.length).toBeGreaterThanOrEqual(3);
    const nearest = parseFloat(eligible[0]!.levelPrice);
    expect([98, 102]).toContain(nearest);
  });

  it('TP from entry ± spacing', () => {
    expect(calcNearPriceTp('102', 'LONG', 2, info)).toBe('104.04');
    expect(calcNearPriceTp('98', 'SHORT', 2, info)).toBe('96.04');
  });

  it('STOP_LIMIT prices: BUY stop=level limit above; SELL stop=level limit below', () => {
    const long = calcStopLimitPrices('102', 'LONG', '0.05', info);
    expect(long.stopPrice).toBe('102.00');
    expect(parseFloat(long.limitPrice)).toBeGreaterThan(102);
    const short = calcStopLimitPrices('98', 'SHORT', '0.05', info);
    expect(short.stopPrice).toBe('98.00');
    expect(parseFloat(short.limitPrice)).toBeLessThan(98);
  });

  it('TEST 7: same level not eligible twice once PENDING with clientOrderId', () => {
    const levels = [
      { level: 1, levelPrice: '102', status: 'PENDING', clientOrderId: 'abc' },
      { level: 2, levelPrice: '104', status: 'EMPTY', clientOrderId: null },
    ];
    const hit = findEligibleEmptyLevels(levels, '100', 2, 2);
    expect(hit.map((l) => l.level)).toEqual([2]);
  });

  it('40 levels exist but only nearby are eligible at start (not all 40)', () => {
    const plans = buildNearPriceLevelPlans({
      startPrice: '100',
      boundaryPercent: 40,
      spacingPercent: 2,
      symbolInfo: info,
    });
    expect(plans).toHaveLength(40);
    expect(plans.every((p) => p.status === 'EMPTY')).toBe(true);
    const eligible = findEligibleEmptyLevels(plans, '100', 2, 2);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.length).toBeLessThan(40);
    // Far levels outside 4% stay empty/not eligible
    const far = plans.find((p) => Math.abs(parseFloat(p.levelPrice) - 100) / parseFloat(p.levelPrice) * 100 > 4);
    expect(far).toBeTruthy();
    expect(eligible.some((e) => e.level === far!.level)).toBe(false);
  });

  it('activation uses CURRENT mark, not start price', () => {
    const plans = buildNearPriceLevelPlans({
      startPrice: '100',
      boundaryPercent: 40,
      spacingPercent: 2,
      symbolInfo: info,
    });
    // Mark moved up — levels near 110 become eligible; levels near 100 may drop out
    const atStart = findEligibleEmptyLevels(plans, '100', 2, 2).map((e) => e.levelPrice);
    const at110 = findEligibleEmptyLevels(plans, '110', 2, 2).map((e) => e.levelPrice);
    expect(at110.length).toBeGreaterThan(0);
    // A level around 114 should be nearer to 110 than to 100
    const near114 = plans.find((p) => Math.abs(parseFloat(p.levelPrice) - 114) < 1);
    if (near114 != null) {
      const inAt110 = at110.includes(near114.levelPrice);
      const inAt100 = atStart.includes(near114.levelPrice);
      expect(inAt110 || !inAt100).toBe(true);
    }
  });

  it('TP_HIT status alone is not eligible (must be EMPTY); EMPTY after TP is eligible', () => {
    const levels = [
      { level: 1, levelPrice: '102', status: 'TP_HIT', clientOrderId: null },
      { level: 2, levelPrice: '98', status: 'EMPTY', clientOrderId: null },
    ];
    const hit = findEligibleEmptyLevels(levels, '100', 2, 2);
    expect(hit.map((l) => l.level)).toEqual([2]);

    // After reusable reset, same price level becomes EMPTY and can trade again
    const reused = findEligibleEmptyLevels(
      [{ level: 1, levelPrice: '102', status: 'EMPTY', clientOrderId: null }],
      '100',
      2,
      2,
    );
    expect(reused.map((l) => l.level)).toEqual([1]);
  });

  it('isNearPriceLevelTerminal: TP_HIT is not terminal (levels are reusable)', () => {
    expect(isNearPriceLevelTerminal('TP_HIT')).toBe(false);
    expect(isNearPriceLevelTerminal('EMPTY')).toBe(false);
    expect(isNearPriceLevelTerminal('ACTIVE')).toBe(false);
    expect(isNearPriceLevelTerminal('CANCELLED')).toBe(true);
    expect(isNearPriceLevelTerminal('SKIPPED')).toBe(true);
  });

  it('resetLevelAfterTpClose returns EMPTY with cleared live fields', () => {
    const reset = resetLevelAfterTpClose();
    expect(reset.status).toBe('EMPTY');
    expect(reset.direction).toBeNull();
    expect(reset.clientOrderId).toBeNull();
    expect(reset.tpPrice).toBeNull();
    expect(reset.allocatedMargin).toBe('0');
  });

  it('same level can flip LONG then SHORT based on current mark', () => {
    expect(assignSideForLevel('98', '100')).toBe('LONG');
    expect(assignSideForLevel('102', '100')).toBe('SHORT');
    expect(assignSideForLevel('99.5', '100')).toBe('LONG');
  });
});

describe('near-price geometric 2↑ LONG + 2↓ SHORT invariant', () => {
  function emptyPlans(start = '100') {
    return buildNearPriceLevelPlans({
      startPrice: start,
      boundaryPercent: 40,
      spacingPercent: 2,
      symbolInfo: info,
    });
  }

  function pricesOf(sel: ReturnType<typeof resolveDesiredNearPriceGrid>) {
    return {
      long: sel.above.map((t) => parseFloat(t.level.levelPrice)),
      short: sel.below.map((t) => parseFloat(t.level.levelPrice)),
    };
  }

  it('TEST 1: two nearest levels strictly above mark are LONG', () => {
    const sel = resolveDesiredNearPriceGrid(emptyPlans(), '100', 2);
    const p = pricesOf(sel);
    expect(p.long).toEqual([102, 104]);
    expect(sel.above.every((t) => t.side === 'LONG')).toBe(true);
  });

  it('TEST 2: two nearest levels strictly below mark are SHORT (includes 96)', () => {
    const sel = resolveDesiredNearPriceGrid(emptyPlans(), '100', 2);
    const p = pricesOf(sel);
    expect(p.short).toEqual([98, 96]);
    expect(sel.below.every((t) => t.side === 'SHORT')).toBe(true);
  });

  it('TEST 3: distant levels remain out of the 2+2 window', () => {
    const sel = resolveDesiredNearPriceGrid(emptyPlans(), '100', 2);
    const all = [...pricesOf(sel).long, ...pricesOf(sel).short];
    expect(all).not.toContain(106);
    expect(all).not.toContain(108);
    expect(all).not.toContain(94);
    expect(sel.targets).toHaveLength(4);
  });

  it('TEST F: mark exactly on a level — level is neither above nor below', () => {
    const sel = resolveDesiredNearPriceGrid(emptyPlans(), '102', 2);
    const p = pricesOf(sel);
    expect(p.long).toEqual([104, 106]);
    expect(p.short).toEqual([98, 96]);
    expect(p.long).not.toContain(102);
    expect(p.short).not.toContain(102);
  });

  it('TEST 4/5: after LONG TP, level below mark is SHORT in desired window', () => {
    const plans = emptyPlans();
    const desired = resolveDesiredNearPriceGrid(plans, '103', 2);
    expect(pricesOf(desired).short).toContain(102);
    expect(desired.below.find((t) => parseFloat(t.level.levelPrice) === 102)?.side).toBe('SHORT');
  });

  it('TEST 6: after SHORT TP, level above mark is LONG in desired window', () => {
    const desired = resolveDesiredNearPriceGrid(emptyPlans(), '101', 2);
    expect(pricesOf(desired).long).toContain(102);
    expect(desired.above.find((t) => parseFloat(t.level.levelPrice) === 102)?.side).toBe('LONG');
  });

  it('TEST 7: same level alternates LONG → SHORT → LONG by current mark', () => {
    const level = '102';
    expect(assignSideForLevel('100', level)).toBe('LONG');
    expect(assignSideForLevel('103', level)).toBe('SHORT');
    expect(assignSideForLevel('101', level)).toBe('LONG');
  });

  it('TEST 8: desired window includes ACTIVE levels (caller leaves filled alone)', () => {
    const plans = emptyPlans().map((p) =>
      parseFloat(p.levelPrice) === 102
        ? { ...p, status: 'ACTIVE' as const }
        : p,
    );
    const desired = resolveDesiredNearPriceGrid(plans, '103', 2);
    expect(pricesOf(desired).short).toContain(102);
    // EMPTY-only legacy helper still excludes ACTIVE
    const emptyOnly = selectNearestTargetLevels(plans as any, '103', 2, 2);
    expect(emptyOnly.targets.some((t) => parseFloat(t.level.levelPrice) === 102)).toBe(false);
  });

  it('TEST 9: desired window is idempotent across repeated calls', () => {
    const plans = emptyPlans();
    const a = resolveDesiredNearPriceGrid(plans, '100', 2);
    const b = resolveDesiredNearPriceGrid(plans, '100', 2);
    expect(pricesOf(a)).toEqual(pricesOf(b));
  });

  it('TEST 10: TP gap — LONG/SHORT mark jumps past TP', () => {
    expect(didCrossTakeProfit('LONG', '101', '105', '102')).toBe(true);
    expect(didCrossTakeProfit('SHORT', '99', '97', '98')).toBe(true);
    expect(didCrossTakeProfit('LONG', '100', '101', '102')).toBe(false);
    expect(isTpTriggeredByMark('LONG', '105', '102')).toBe(true);
  });

  it('TEST 10b: stop trigger gap for LONG/SHORT entry', () => {
    expect(didCrossStopTrigger('LONG', '101', '103', '102')).toBe(true);
    expect(didCrossStopTrigger('SHORT', '99', '97', '98')).toBe(true);
    expect(didCrossStopTrigger('LONG', '100', '101', '102')).toBe(false);
  });

  it('TEST 11: capped at exactly 2 per side even when many levels exist', () => {
    const sel = resolveDesiredNearPriceGrid(emptyPlans(), '100', 2);
    expect(sel.above).toHaveLength(2);
    expect(sel.below).toHaveLength(2);
  });

  it('TEST 12: upward jump — desired window follows CURRENT mark', () => {
    const plans = emptyPlans();
    const at100 = pricesOf(resolveDesiredNearPriceGrid(plans, '100', 2));
    const at110 = pricesOf(resolveDesiredNearPriceGrid(plans, '110', 2));
    expect(at100.long).toEqual([102, 104]);
    expect(at110.long.every((x) => x > 110)).toBe(true);
    expect(at110.short.every((x) => x < 110)).toBe(true);
    expect(at110.long).not.toEqual(at100.long);
  });

  it('TEST 13: downward jump — desired window follows CURRENT mark', () => {
    const at90 = pricesOf(resolveDesiredNearPriceGrid(emptyPlans(), '90', 2));
    expect(at90.long.every((x) => x > 90)).toBe(true);
    expect(at90.short.every((x) => x < 90)).toBe(true);
  });

  it('TEST 14: LONG→TP→SHORT→TP→LONG cycle via mark relationship', () => {
    const levelPrice = '102';
    expect(assignSideForLevel('100', levelPrice)).toBe('LONG');
    const longTp = calcNearPriceTp(levelPrice, 'LONG', 2, info);
    expect(didCrossTakeProfit('LONG', '103', '105', longTp)).toBe(true);
    expect(assignSideForLevel('105', levelPrice)).toBe('SHORT');
    const shortTp = calcNearPriceTp(levelPrice, 'SHORT', 2, info);
    expect(didCrossTakeProfit('SHORT', '101', '99', shortTp)).toBe(true);
    expect(assignSideForLevel('101', levelPrice)).toBe('LONG');
  });

  it('TEST C: multi-level upward jump ends with correct 2+2 around final mark', () => {
    const plans = emptyPlans();
    // jump 99 → 107
    const final = pricesOf(resolveDesiredNearPriceGrid(plans, '107', 2));
    expect(final.long).toEqual([108, 110]);
    expect(final.short).toEqual([106, 104]);
  });

  it('TEST D: multi-level downward jump ends with correct 2+2 around final mark', () => {
    const plans = emptyPlans();
    const final = pricesOf(resolveDesiredNearPriceGrid(plans, '93', 2));
    expect(final.long.every((x) => x > 93)).toBe(true);
    expect(final.short.every((x) => x < 93)).toBe(true);
    expect(final.long).toHaveLength(2);
    expect(final.short).toHaveLength(2);
  });

  it('legacy activation-gated selector still excludes 96 at mark 100', () => {
    const sel = selectNearestTargetLevels(emptyPlans(), '100', 2, 2);
    expect(sel.below.map((t) => parseFloat(t.level.levelPrice))).toEqual([98]);
  });
});
