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
} from '../../src/modules/trader/near-price/nearPriceGridCalc';
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
});
