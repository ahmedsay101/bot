import Decimal from 'decimal.js';
import {
  calcShortTakeProfit,
  calcHedgeEntry,
  calcHedgeStopLoss,
  calcHedgeTakeProfit,
  calcNextHedgeEntry,
  planHedgeFromReference,
} from '../../src/modules/calc/strategy';

const DEFAULTS = {
  hedgeDistance: '0.10',
  hedgeSlPercent: '0.03',
  hedgeTpPercent: '0.10',
  shortTpPercent: '0.10',
};

describe('strategy calculation service', () => {
  it('short TP is configured % below entry', () => {
    expect(calcShortTakeProfit('100', '0.10').toFixed(2)).toBe('90.00');
  });

  it('hedge entry is configured % above previous reference', () => {
    expect(calcHedgeEntry('100', '0.10').toFixed(2)).toBe('110.00');
  });

  it('hedge SL is configured % below hedge entry (not previous level)', () => {
    expect(calcHedgeStopLoss('110', '0.03').toFixed(2)).toBe('106.70');
    expect(calcHedgeStopLoss('110', '0.03').toFixed(2)).not.toBe('100.00');
  });

  it('hedge TP is configured % above hedge entry', () => {
    expect(calcHedgeTakeProfit('110', '0.10').toFixed(2)).toBe('121.00');
  });

  it('next hedge entry uses previous TP × (1 + distance)', () => {
    expect(calcNextHedgeEntry('121', '0.10').toFixed(2)).toBe('133.10');
  });

  it('planHedgeFromReference builds full L1 ladder', () => {
    const plan = planHedgeFromReference('100', DEFAULTS);
    expect(plan.previousReference).toBe('100');
    expect(plan.entry.toFixed(2)).toBe('110.00');
    expect(plan.stopLoss.toFixed(2)).toBe('106.70');
    expect(plan.takeProfit.toFixed(2)).toBe('121.00');
  });

  it('progression L2 from hedge TP fill', () => {
    const l2 = planHedgeFromReference('121', DEFAULTS);
    expect(l2.entry.toFixed(2)).toBe('133.10');
    expect(l2.stopLoss.toFixed(3)).toBe('129.107'); // 133.10 × 0.97
    expect(l2.takeProfit.toFixed(2)).toBe('146.41');
  });

  it('recreate keeps identical prices when reusing plan inputs', () => {
    const a = planHedgeFromReference('100', DEFAULTS);
    const b = planHedgeFromReference('100', DEFAULTS);
    expect(a.entry.equals(b.entry)).toBe(true);
    expect(a.stopLoss.equals(b.stopLoss)).toBe(true);
    expect(a.takeProfit.equals(b.takeProfit)).toBe(true);
  });

  it('respects custom percents', () => {
    const plan = planHedgeFromReference('200', {
      hedgeDistance: '0.05',
      hedgeSlPercent: '0.02',
      hedgeTpPercent: '0.08',
    });
    expect(plan.entry.toFixed(2)).toBe('210.00');
    expect(plan.stopLoss.toFixed(2)).toBe('205.80');
    expect(plan.takeProfit.toFixed(2)).toBe('226.80');
  });

  it('uses Decimal.js (no float drift on chain)', () => {
    let ref = new Decimal('100');
    for (let i = 0; i < 5; i++) {
      const plan = planHedgeFromReference(ref, DEFAULTS);
      ref = plan.takeProfit;
    }
    expect(ref.isFinite()).toBe(true);
    expect(ref.gt(0)).toBe(true);
  });
});
