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
  nearestGridLevelsByMark,
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

describe('near-price 2↑ LONG + 2↓ SHORT target selection', () => {
  function emptyPlans(start = '100') {
    return buildNearPriceLevelPlans({
      startPrice: start,
      boundaryPercent: 40,
      spacingPercent: 2,
      symbolInfo: info,
    });
  }

  function pricesOf(sel: ReturnType<typeof selectNearestTargetLevels>) {
    return {
      long: sel.above.map((t) => parseFloat(t.level.levelPrice)),
      short: sel.below.map((t) => parseFloat(t.level.levelPrice)),
      sides: sel.targets.map((t) => t.side),
    };
  }

  it('TEST 1: two nearest eligible above mark are LONG', () => {
    const sel = selectNearestTargetLevels(emptyPlans(), '100', 2, 2);
    const p = pricesOf(sel);
    expect(p.long).toEqual([102, 104]);
    expect(sel.above.every((t) => t.side === 'LONG')).toBe(true);
  });

  it('TEST 2: nearest eligible below mark are SHORT (96 outside 4% level-ref)', () => {
    const sel = selectNearestTargetLevels(emptyPlans(), '100', 2, 2);
    const p = pricesOf(sel);
    expect(p.short).toEqual([98]);
    expect(sel.below.every((t) => t.side === 'SHORT')).toBe(true);
    expect(p.short).not.toContain(96);
  });

  it('TEST 3: distant levels remain out of targets', () => {
    const sel = selectNearestTargetLevels(emptyPlans(), '100', 2, 2);
    const all = [...pricesOf(sel).long, ...pricesOf(sel).short];
    expect(all).not.toContain(106);
    expect(all).not.toContain(108);
    expect(all).not.toContain(94);
    expect(sel.targets.length).toBeLessThanOrEqual(NEAR_PRICE_MAX_PER_SIDE * 2);
  });

  it('TEST 4/5: after LONG TP, level EMPTY above→below mark becomes SHORT target', () => {
    const plans = emptyPlans().map((p) => ({ ...p, clientOrderId: null as string | null }));
    // Simulate 102 occupied ACTIVE LONG — not selectable
    const with102Active = plans.map((p) =>
      parseFloat(p.levelPrice) === 102
        ? { ...p, status: 'ACTIVE' as const, clientOrderId: 'x' }
        : p,
    );
    const before = selectNearestTargetLevels(with102Active, '103', 2, 2);
    expect(pricesOf(before).short).not.toContain(102);

    // After TP → EMPTY at mark 103
    const afterTp = with102Active.map((p) =>
      parseFloat(p.levelPrice) === 102
        ? { ...p, status: 'EMPTY' as const, clientOrderId: null }
        : p,
    );
    const after = selectNearestTargetLevels(afterTp, '103', 2, 2);
    expect(assignSideForLevel('103', '102')).toBe('SHORT');
    expect(pricesOf(after).short).toContain(102);
    const t102 = after.below.find((t) => parseFloat(t.level.levelPrice) === 102);
    expect(t102?.side).toBe('SHORT');
  });

  it('TEST 6: after SHORT TP, mark below level → LONG', () => {
    const plans = emptyPlans().map((p) => ({ ...p, clientOrderId: null as string | null }));
    const afterTp = plans; // 102 empty
    const after = selectNearestTargetLevels(afterTp, '101', 2, 2);
    expect(assignSideForLevel('101', '102')).toBe('LONG');
    expect(pricesOf(after).long).toContain(102);
  });

  it('TEST 7: same level alternates LONG → SHORT → LONG by current mark', () => {
    const level = '102';
    expect(assignSideForLevel('100', level)).toBe('LONG');
    expect(assignSideForLevel('103', level)).toBe('SHORT');
    expect(assignSideForLevel('101', level)).toBe('LONG');
  });

  it('TEST 8: occupied ACTIVE level is not retargeted (no flip while open)', () => {
    const plans = emptyPlans().map((p) =>
      parseFloat(p.levelPrice) === 102
        ? { ...p, status: 'ACTIVE' as const, clientOrderId: 'live', direction: 'LONG' }
        : { ...p, clientOrderId: null as string | null },
    );
    const sel = selectNearestTargetLevels(plans, '103', 2, 2);
    // 102 still ACTIVE LONG — not in create targets
    expect(sel.targets.some((t) => parseFloat(t.level.levelPrice) === 102)).toBe(false);
    // geometric nearest below still includes 102 for audit
    const geo = nearestGridLevelsByMark(plans, '103', 2);
    expect(geo.below.map((l) => parseFloat(l.levelPrice))).toContain(102);
  });

  it('TEST 9: repeated selection does not duplicate PENDING levels', () => {
    const plans = emptyPlans().map((p) => {
      const px = parseFloat(p.levelPrice);
      if (px === 102 || px === 104) {
        return { ...p, status: 'PENDING' as const, clientOrderId: `oid-${px}` };
      }
      return { ...p, clientOrderId: null as string | null };
    });
    const a = selectNearestTargetLevels(plans, '100', 2, 2);
    const b = selectNearestTargetLevels(plans, '100', 2, 2);
    expect(a.above).toHaveLength(0);
    expect(b.above).toHaveLength(0);
    expect(a.below.map((t) => t.level.levelPrice)).toEqual(b.below.map((t) => t.level.levelPrice));
  });

  it('TEST 10: TP gap — LONG mark jumps past TP', () => {
    expect(isTpTriggeredByMark('LONG', '105', '102')).toBe(true);
    expect(isTpTriggeredByMark('SHORT', '97', '98')).toBe(true);
    expect(isTpTriggeredByMark('LONG', '101', '102')).toBe(false);
  });

  it('TEST 11: several eligible — only nearest 2 per side selected', () => {
    // Wider activation so more empties qualify; still capped at 2/side
    const plans = emptyPlans().map((p) => ({ ...p, clientOrderId: null as string | null }));
    const sel = selectNearestTargetLevels(plans, '100', 2, 10); // 20% zone
    expect(sel.above.length).toBe(2);
    expect(sel.below.length).toBe(2);
    expect(pricesOf(sel).long).toEqual([102, 104]);
    expect(pricesOf(sel).short).toEqual([98, 96]);
  });

  it('TEST 12: upward trend — targets move with CURRENT mark', () => {
    const plans = emptyPlans().map((p) => ({ ...p, clientOrderId: null as string | null }));
    const at100 = pricesOf(selectNearestTargetLevels(plans, '100', 2, 2));
    const at110 = pricesOf(selectNearestTargetLevels(plans, '110', 2, 2));
    expect(at100.long).toEqual([102, 104]);
    expect(at110.long[0]).toBeGreaterThan(110);
    // exact level at mark → SHORT (lte); otherwise strictly below
    expect(at110.short[0]).toBeLessThanOrEqual(110);
    expect(at110.long).not.toEqual(at100.long);
  });

  it('TEST 13: downward trend — targets move with CURRENT mark', () => {
    const plans = emptyPlans().map((p) => ({ ...p, clientOrderId: null as string | null }));
    const at90 = pricesOf(selectNearestTargetLevels(plans, '90', 2, 2));
    expect(at90.long.every((x) => x > 90)).toBe(true);
    expect(at90.short.every((x) => x <= 90)).toBe(true);
  });

  it('TEST 14: after TP reset + reassignment cycle LONG→SHORT→LONG', () => {
    const levelPrice = '102';
    let status: 'EMPTY' | 'ACTIVE' = 'EMPTY';
    let side = assignSideForLevel('100', levelPrice);
    expect(side).toBe('LONG');
    status = 'ACTIVE';

    const longTp = calcNearPriceTp(levelPrice, 'LONG', 2, info);
    expect(isTpTriggeredByMark('LONG', '105', longTp)).toBe(true);
    status = 'EMPTY';
    side = assignSideForLevel('105', levelPrice);
    expect(side).toBe('SHORT');
    status = 'ACTIVE';

    const shortTp = calcNearPriceTp(levelPrice, 'SHORT', 2, info);
    expect(isTpTriggeredByMark('SHORT', '99', shortTp)).toBe(true);
    status = 'EMPTY';
    side = assignSideForLevel('101', levelPrice);
    expect(side).toBe('LONG');
    expect(status).toBe('EMPTY');
  });

  it('geometric nearest (any status) at mark 103: above 104/106, below 102/98', () => {
    const plans = emptyPlans();
    const geo = nearestGridLevelsByMark(plans, '103', 2);
    expect(geo.above.map((l) => parseFloat(l.levelPrice))).toEqual([104, 106]);
    expect(geo.below.map((l) => parseFloat(l.levelPrice))).toEqual([102, 98]);
  });

  it('selection uses CURRENT mark not start (mark=110)', () => {
    const plans = emptyPlans('100').map((p) => ({ ...p, clientOrderId: null as string | null }));
    const geo = nearestGridLevelsByMark(plans, '110', 2);
    expect(parseFloat(geo.above[0]!.levelPrice)).toBeGreaterThan(110);
    expect(parseFloat(geo.below[0]!.levelPrice)).toBeLessThanOrEqual(110);
  });
});
