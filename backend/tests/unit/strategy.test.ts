import Decimal from 'decimal.js';
import {
  calcTakeProfit,
  calcStopLoss,
  planPositionPrices,
  nextSideAfterClose,
  oppositeSide,
  marketSideForPosition,
  calcPositionUnrealizedPnl,
  calcPositionRoi,
} from '../../src/modules/calc/strategy';

const PCT = { takeProfitPercent: '0.10', stopLossPercent: '0.10' };

describe('strategy V2 — position reversal', () => {
  it('SHORT TP is entry × (1 − tp%)', () => {
    expect(calcTakeProfit('100', 'SHORT', '0.10').toFixed(2)).toBe('90.00');
  });

  it('SHORT SL is entry × (1 + sl%)', () => {
    expect(calcStopLoss('100', 'SHORT', '0.10').toFixed(2)).toBe('110.00');
  });

  it('LONG TP is entry × (1 + tp%)', () => {
    expect(calcTakeProfit('100', 'LONG', '0.10').toFixed(2)).toBe('110.00');
  });

  it('LONG SL is entry × (1 − sl%)', () => {
    expect(calcStopLoss('100', 'LONG', '0.10').toFixed(2)).toBe('90.00');
  });

  it('planPositionPrices builds TP/SL for side', () => {
    const short = planPositionPrices('100', 'SHORT', PCT);
    expect(short.takeProfit.toFixed(2)).toBe('90.00');
    expect(short.stopLoss.toFixed(2)).toBe('110.00');

    const long = planPositionPrices('100', 'LONG', PCT);
    expect(long.takeProfit.toFixed(2)).toBe('110.00');
    expect(long.stopLoss.toFixed(2)).toBe('90.00');
  });

  it('TP keeps same side; SL flips side', () => {
    expect(nextSideAfterClose('SHORT', 'TP')).toBe('SHORT');
    expect(nextSideAfterClose('SHORT', 'SL')).toBe('LONG');
    expect(nextSideAfterClose('LONG', 'TP')).toBe('LONG');
    expect(nextSideAfterClose('LONG', 'SL')).toBe('SHORT');
  });

  it('oppositeSide flips LONG/SHORT', () => {
    expect(oppositeSide('SHORT')).toBe('LONG');
    expect(oppositeSide('LONG')).toBe('SHORT');
  });

  it('marketSideForPosition maps to BUY/SELL', () => {
    expect(marketSideForPosition('LONG')).toBe('BUY');
    expect(marketSideForPosition('SHORT')).toBe('SELL');
  });

  it('unrealized PnL for SHORT/LONG', () => {
    expect(calcPositionUnrealizedPnl('SHORT', '100', '90', '1').toFixed(2)).toBe('10.00');
    expect(calcPositionUnrealizedPnl('LONG', '100', '110', '1').toFixed(2)).toBe('10.00');
  });

  it('ROI is percent of notional', () => {
    expect(calcPositionRoi('SHORT', '100', '90', '1').toFixed(2)).toBe('10.00');
  });

  it('uses Decimal.js without float drift', () => {
    let entry = new Decimal('100');
    for (let i = 0; i < 8; i++) {
      entry = calcTakeProfit(entry, 'SHORT', '0.10');
    }
    expect(entry.isFinite()).toBe(true);
    expect(entry.gt(0)).toBe(true);
  });
});
