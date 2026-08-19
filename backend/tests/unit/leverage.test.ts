/**
 * Leverage correctness — margin → notional → qty → PnL (once).
 * Testing and Live share these formulas.
 */
import Decimal from 'decimal.js';
import {
  calcPositionNotional,
  calcActualNotional,
  calcMarginFromNotional,
  calcGrossPnlFromNotional,
  calcLeveragedGrossPnl,
  calcLeveragedUnrealizedPnl,
  calcFeeOnNotional,
  calcLeveragedNetPnl,
  reconcilePositionNotional,
} from '../../src/modules/calc/leverage';
import { calcQuantityFromNotional, calcAllocation } from '../../src/modules/calc/allocation';
import { calcEquity, calcUsedMargin } from '../../src/modules/calc/accounting';
import { buildGridPlan, traderProfitPercent } from '../../src/modules/trader/grid/gridCalc';
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

describe('leverage SSOT', () => {
  it('Test 1: 1x — $10 margin → $10 notional → +$1 on +10% LONG', () => {
    const margin = '10';
    const lev = 1;
    const notional = calcPositionNotional(margin, lev);
    expect(notional.toFixed(0)).toBe('10');
    const qty = notional.div(100); // entry 100
    const gross = calcLeveragedGrossPnl('LONG', '100', '110', qty);
    expect(gross.toFixed(0)).toBe('1');
    expect(calcGrossPnlFromNotional('LONG', '100', '110', notional).toFixed(0)).toBe('1');
  });

  it('Test 2: 5x — $10 margin → $50 notional → +$5 on +10% LONG', () => {
    const notional = calcPositionNotional('10', 5);
    expect(notional.toFixed(0)).toBe('50');
    const qty = notional.div(100);
    expect(calcLeveragedGrossPnl('LONG', '100', '110', qty).toFixed(0)).toBe('5');
    expect(calcGrossPnlFromNotional('LONG', '100', '110', notional).toFixed(0)).toBe('5');
  });

  it('Test 3: 10x — $10 margin → $100 notional → +$10 on +10% LONG', () => {
    const notional = calcPositionNotional('10', 10);
    expect(notional.toFixed(0)).toBe('100');
    const qty = notional.div(100);
    expect(calcLeveragedGrossPnl('LONG', '100', '110', qty).toFixed(0)).toBe('10');
  });

  it('Test 4: SHORT 5x — entry 100 → exit 90 → +$5', () => {
    const notional = calcPositionNotional('10', 5);
    const qty = notional.div(100);
    expect(calcLeveragedGrossPnl('SHORT', '100', '90', qty).toFixed(0)).toBe('5');
    expect(calcGrossPnlFromNotional('SHORT', '100', '90', notional).toFixed(0)).toBe('5');
  });

  it('Test 5: Losing LONG 5x — entry 100 → exit 90 → -$5', () => {
    const qty = calcPositionNotional('10', 5).div(100);
    expect(calcLeveragedGrossPnl('LONG', '100', '90', qty).toFixed(0)).toBe('-5');
  });

  it('Test 6: Fees from executed notional; net = gross − fees', () => {
    const margin = '10';
    const lev = 5;
    const notional = calcPositionNotional(margin, lev); // 50
    const qty = notional.div(100); // 0.5
    const rate = '0.001'; // 0.1%
    const entryFee = calcFeeOnNotional('100', qty, rate); // 0.05
    const exitFee = calcFeeOnNotional('110', qty, rate); // 0.055
    const gross = calcLeveragedGrossPnl('LONG', '100', '110', qty); // 5
    const net = calcLeveragedNetPnl(gross, entryFee, exitFee);
    expect(entryFee.toFixed(3)).toBe('0.050');
    expect(exitFee.toFixed(3)).toBe('0.055');
    expect(gross.toFixed(0)).toBe('5');
    expect(net.toFixed(3)).toBe('4.895');
  });

  it('Test 7: quantity = (margin × leverage) / price with filters', () => {
    const notional = calcPositionNotional('10', 5); // 50
    const qty = calcQuantityFromNotional(notional, '100', info);
    expect(qty).toBe('0.500');
    expect(calcActualNotional('100', qty).toFixed(0)).toBe('50');
  });

  it('Test 8: every grid level margin × leverage → notional → qty', () => {
    const plan = buildGridPlan({
      startPrice: '100',
      traderAllocation: '100',
      leverage: 5,
      levelsPerSide: 10,
      distancePercent: 5,
      symbolInfo: info,
    });
    for (const level of plan.levels) {
      const expected = calcPositionNotional(level.allocatedMargin, 5);
      const actual = new Decimal(level.notional);
      // After qty rounding, notional ≈ margin × lev
      const ratio = expected.isZero() ? new Decimal(1) : actual.div(expected);
      expect(ratio.gte('0.98') && ratio.lte('1.02')).toBe(true);
      if (new Decimal(level.quantity).gt(0)) {
        expect(calcActualNotional(level.triggerPrice, level.quantity).toFixed(8)).toBe(level.notional);
      }
    }
  });

  it('Test 9: combined trader PnL across leveraged legs', () => {
    // LONG #1: margin 5, lev 5 → notional 25, +$2
    // LONG #2: margin 10 → notional 50, +$5
    // SHORT #1: margin 15 → notional 75, -$3
    const p1 = calcLeveragedGrossPnl('LONG', '100', '108', calcPositionNotional('5', 5).div(100)); // 2
    const p2 = calcLeveragedGrossPnl('LONG', '100', '110', calcPositionNotional('10', 5).div(100)); // 5
    const p3 = calcLeveragedGrossPnl('SHORT', '100', '104', calcPositionNotional('15', 5).div(100)); // -3
    const combined = p1.plus(p2).plus(p3);
    expect(combined.toFixed(0)).toBe('4');
    expect(traderProfitPercent(combined, '100').toFixed(0)).toBe('4');
  });

  it('Test 10: leverage applied exactly once (no double count)', () => {
    const margin = new Decimal('10');
    const lev = 5;
    const notional = calcPositionNotional(margin, lev);
    const qty = notional.div(100);
    const correct = calcLeveragedGrossPnl('LONG', '100', '110', qty);
    // Wrong: margin × lev × lev × 10%
    const doubleLev = margin.mul(lev).mul(lev).mul('0.10');
    expect(correct.toFixed(0)).toBe('5');
    expect(doubleLev.toFixed(0)).toBe('25');
    expect(correct.eq(doubleLev)).toBe(false);
    // Wrong: margin × move only (ignore lev)
    const noLev = margin.mul('0.10');
    expect(noLev.toFixed(0)).toBe('1');
    expect(correct.eq(noLev)).toBe(false);
  });

  it('Test 11: Testing vs Live local math identical for same inputs', () => {
    const margin = '10';
    const lev = 5;
    const entry = '100';
    const exit = '110';
    const rate = '0.0005';
    const notional = calcPositionNotional(margin, lev);
    const qty = notional.div(entry);
    // "Testing" path
    const tGross = calcLeveragedGrossPnl('LONG', entry, exit, qty);
    const tFees = calcFeeOnNotional(entry, qty, rate).plus(calcFeeOnNotional(exit, qty, rate));
    const tNet = calcLeveragedNetPnl(tGross, calcFeeOnNotional(entry, qty, rate), calcFeeOnNotional(exit, qty, rate));
    // "Live local estimate" path (same helpers)
    const lGross = calcGrossPnlFromNotional('LONG', entry, exit, notional);
    const lNet = calcLeveragedNetPnl(lGross, calcFeeOnNotional(entry, qty, rate), calcFeeOnNotional(exit, qty, rate));
    expect(tGross.toFixed(8)).toBe(lGross.toFixed(8));
    expect(tNet.toFixed(8)).toBe(lNet.toFixed(8));
    expect(tFees.toFixed(8)).toBe(
      calcFeeOnNotional(entry, qty, rate).plus(calcFeeOnNotional(exit, qty, rate)).toFixed(8),
    );
  });

  it('Final verification: $10 @ 5x LONG 100→110 ≈ +$4.90 net at 0.1% fees', () => {
    const notional = calcPositionNotional('10', 5);
    const qty = notional.div(100);
    const gross = calcLeveragedGrossPnl('LONG', '100', '110', qty);
    const entryFee = calcFeeOnNotional('100', qty, '0.001');
    const exitFee = calcFeeOnNotional('110', qty, '0.001');
    const net = calcLeveragedNetPnl(gross, entryFee, exitFee);
    expect(notional.toFixed(0)).toBe('50');
    expect(gross.toFixed(0)).toBe('5');
    expect(net.toFixed(3)).toBe('4.895');
  });

  it('Final verification SHORT: $10 @ 5x entry 100 → 90 → +$5 gross', () => {
    const qty = calcPositionNotional('10', 5).div(100);
    expect(calcLeveragedGrossPnl('SHORT', '100', '90', qty).toFixed(0)).toBe('5');
  });

  it('equity = balance + unrealized — does NOT add notional as cash', () => {
    // balance 2000, unrealized +5, open notional 50 @ 5x
    expect(calcEquity('2000', '5').toFixed(0)).toBe('2005');
    expect(calcUsedMargin(['50'], 5).toFixed(0)).toBe('10');
    // Must NOT be 2050
    expect(calcEquity('2000', '5').eq('2050')).toBe(false);
  });

  it('allocation: trader margin vs notional clearly separated', () => {
    const a = calcAllocation('2000', 4, 10);
    expect(a.traderEquity.toFixed(0)).toBe('500'); // margin capital
    expect(a.positionNotional.toFixed(0)).toBe('5000'); // exposure
    expect(a.positionNotional.eq(a.traderEquity)).toBe(false);
  });

  it('reconcilePositionNotional flags large mismatches', () => {
    const ok = reconcilePositionNotional({
      allocatedMargin: '10',
      leverage: 5,
      actualNotional: '50',
    });
    expect(ok.ok).toBe(true);
    const bad = reconcilePositionNotional({
      allocatedMargin: '10',
      leverage: 5,
      actualNotional: '10', // forgot leverage
      traderId: 't-test',
    });
    expect(bad.ok).toBe(false);
  });

  it('unrealized matches qty×Δprice (leverage already in qty)', () => {
    const qty = calcPositionNotional('10', 5).div(100).toFixed();
    expect(calcLeveragedUnrealizedPnl('LONG', '100', '110', qty).toFixed(0)).toBe('5');
  });

  it('marginFromNotional inverse of positionNotional', () => {
    expect(calcMarginFromNotional('50', 5).toFixed(0)).toBe('10');
  });
});
