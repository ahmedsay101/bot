/**
 * Binance Futures fee accounting — Decimal.js SSOT shared by Live + Simulation.
 */
import Decimal from 'decimal.js';
import {
  estimateExecutionFee,
  resolveExecutionFee,
  calcGrossPnl,
  calcNetPnl,
  buildPositionFeeBreakdown,
  estimateOpenExitFee,
  feeRatesFromConfig,
} from '../../src/modules/calc/fees';
import { applyRealizedTrade, calcEquity } from '../../src/modules/calc/accounting';
import { calcStepAmount, buildStepLadder } from '../../src/modules/calc/capitalSteps';

const RATES = { makerFeeRate: '0.0002', takerFeeRate: '0.0005' };

describe('fees SSOT', () => {
  it('estimates market fee from executed notional × taker', () => {
    // 1 × 100 × 0.0005 = 0.05
    expect(estimateExecutionFee('100', '1', RATES.takerFeeRate).toFixed(8)).toBe('0.05000000');
  });

  it('prefers actual Binance commission over estimate', () => {
    const fee = resolveExecutionFee({
      price: '100',
      quantity: '1',
      actualFee: '0.042',
      rates: RATES,
      liquidity: 'TAKER',
    });
    expect(fee.toFixed(3)).toBe('0.042');
  });

  it('falls back to estimate when actual fee missing', () => {
    const fee = resolveExecutionFee({
      price: '100',
      quantity: '1',
      actualFee: null,
      rates: RATES,
      liquidity: 'TAKER',
    });
    expect(fee.toFixed(2)).toBe('0.05');
  });

  it('profitable position: net = gross − entry − exit', () => {
    const entryFee = estimateExecutionFee('100', '1', RATES.takerFeeRate);
    const exitFee = estimateExecutionFee('110', '1', RATES.takerFeeRate);
    const b = buildPositionFeeBreakdown('LONG', '100', '110', '1', entryFee, exitFee);
    expect(b.grossPnl.toFixed(0)).toBe('10');
    expect(b.totalFees.toFixed(8)).toBe(entryFee.plus(exitFee).toFixed(8));
    expect(b.netPnl.toFixed(8)).toBe(calcNetPnl(b.grossPnl, entryFee, exitFee).toFixed(8));
    expect(b.netPnl.toFixed(3)).toBe('9.895'); // 10 − 0.05 − 0.055
  });

  it('losing position still charges fees', () => {
    const entryFee = new Decimal('0.05');
    const exitFee = new Decimal('0.04');
    const b = buildPositionFeeBreakdown('LONG', '100', '90', '1', entryFee, exitFee);
    expect(b.grossPnl.toFixed(0)).toBe('-10');
    expect(b.netPnl.toFixed(2)).toBe('-10.09');
  });

  it('multiple positions accumulate fees correctly', () => {
    const p1 = buildPositionFeeBreakdown('LONG', '100', '105', '1', '0.05', '0.0525');
    const p2 = buildPositionFeeBreakdown('LONG', '100', '97', '1', '0.05', '0.0485');
    const p3 = buildPositionFeeBreakdown('SHORT', '100', '92', '1', '0.05', '0.046');
    const gross = p1.grossPnl.plus(p2.grossPnl).plus(p3.grossPnl);
    const fees = p1.totalFees.plus(p2.totalFees).plus(p3.totalFees);
    const net = p1.netPnl.plus(p2.netPnl).plus(p3.netPnl);
    expect(gross.toFixed(1)).toBe('10.0'); // 5 − 3 + 8
    expect(fees.toFixed(4)).toBe('0.2970');
    expect(net.toFixed(8)).toBe(gross.minus(fees).toFixed(8));
  });

  it('balance reflects net realized after entry + exit fees', () => {
    let bal = new Decimal('200');
    let realized = new Decimal('0');
    let fees = new Decimal('0');

    // Entry fee
    let next = applyRealizedTrade(bal, realized, fees, '0', '0.05');
    bal = next.balance;
    realized = next.realizedPnl;
    fees = next.totalFees;
    expect(bal.toFixed(2)).toBe('199.95');

    // Close: gross +10, exit fee 0.055
    next = applyRealizedTrade(bal, realized, fees, '10', '0.055');
    bal = next.balance;
    realized = next.realizedPnl;
    fees = next.totalFees;

    expect(bal.toFixed(3)).toBe('209.895');
    expect(realized.toFixed(3)).toBe('9.895');
    expect(fees.toFixed(3)).toBe('0.105');
  });

  it('equity = balance + gross unrealized (entry fee already in balance)', () => {
    const balance = new Decimal('199.95'); // after entry fee
    const unrealized = new Decimal('2.75');
    expect(calcEquity(balance, unrealized).toFixed(2)).toBe('202.70');
  });

  it('live actual commission overrides estimate (reconciliation path)', () => {
    const estimate = estimateExecutionFee('50000', '0.01', RATES.takerFeeRate);
    const actual = resolveExecutionFee({
      price: '50000',
      quantity: '0.01',
      actualFee: '0.21',
      rates: RATES,
      liquidity: 'TAKER',
    });
    expect(estimate.toFixed(2)).toBe('0.25');
    expect(actual.toFixed(2)).toBe('0.21');
  });

  it('testing and live fee math parity given identical fills', () => {
    const rates = feeRatesFromConfig({
      makerFeeRate: '0.0002',
      takerFeeRate: '0.0005',
      feeRate: '0.0005',
    });
    const entryFee = resolveExecutionFee({
      price: '100',
      quantity: '2',
      actualFee: null,
      rates,
      liquidity: 'TAKER',
    });
    const exitFee = resolveExecutionFee({
      price: '105',
      quantity: '2',
      actualFee: null,
      rates,
      liquidity: 'TAKER',
    });
    const sim = buildPositionFeeBreakdown('LONG', '100', '105', '2', entryFee, exitFee);
    const live = buildPositionFeeBreakdown(
      'LONG',
      '100',
      '105',
      '2',
      resolveExecutionFee({ price: '100', quantity: '2', actualFee: entryFee, rates, liquidity: 'TAKER' }),
      resolveExecutionFee({ price: '105', quantity: '2', actualFee: exitFee, rates, liquidity: 'TAKER' }),
    );
    expect(sim.netPnl.toFixed(8)).toBe(live.netPnl.toFixed(8));
    expect(sim.totalFees.toFixed(8)).toBe(live.totalFees.toFixed(8));
  });

  it('capital steps are unchanged by fees', () => {
    const allocation = new Decimal('100');
    const steps = 5;
    const ladder = buildStepLadder(allocation, steps);
    expect(ladder.map((s) => s.amount.toFixed(0))).toEqual(['20', '40', '60', '80', '100']);
    // Fees reduce balance but step math stays frozen on allocation
    expect(calcStepAmount(allocation, steps, 3).toFixed(0)).toBe('60');
  });

  it('precision: tiny prices/qty with Decimal.js', () => {
    const fee = estimateExecutionFee('0.00001234', '1000000', '0.0005');
    expect(fee.toFixed(10)).toBe('0.0061700000');
    const gross = calcGrossPnl('LONG', '0.00001234', '0.00001250', '1000000');
    expect(gross.toFixed(8)).toBe('0.16000000');
  });

  it('open position estimated exit fee for net unrealized display', () => {
    const exitEst = estimateOpenExitFee('110', '1', RATES);
    expect(exitEst.toFixed(3)).toBe('0.055');
    const grossUnreal = calcGrossPnl('LONG', '100', '110', '1');
    const entryFee = new Decimal('0.05');
    const netUnreal = grossUnreal.minus(entryFee).minus(exitEst);
    expect(netUnreal.toFixed(3)).toBe('9.895');
  });

  it('idempotent fee event keys — same id must not double-charge', () => {
    const seen = new Set<string>();
    const book = (key: string, amount: Decimal, acc: Decimal): Decimal => {
      if (seen.has(key)) return acc;
      seen.add(key);
      return acc.plus(amount);
    };
    let fees = new Decimal(0);
    fees = book('exit:ord1:ex1:1', new Decimal('0.05'), fees);
    fees = book('exit:ord1:ex1:1', new Decimal('0.05'), fees);
    expect(fees.toFixed(2)).toBe('0.05');
  });

  it('short TP and SL both include entry+exit fees', () => {
    const tp = buildPositionFeeBreakdown('SHORT', '100', '90', '1', '0.05', '0.045');
    expect(tp.grossPnl.toFixed(0)).toBe('10');
    expect(tp.netPnl.toFixed(3)).toBe('9.905');

    const sl = buildPositionFeeBreakdown('SHORT', '100', '110', '1', '0.05', '0.055');
    expect(sl.grossPnl.toFixed(0)).toBe('-10');
    expect(sl.netPnl.toFixed(3)).toBe('-10.105');
  });
});
