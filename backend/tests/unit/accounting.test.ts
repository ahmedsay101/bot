import Decimal from 'decimal.js';
import {
  applyRealizedTrade,
  buildAccountSnapshot,
  calcEquity,
  calcUsedMargin,
  calcAvailableMargin,
  testingStartingBalance,
  reconcileTraderAccounting,
  reconcileGlobalAccounting,
} from '../../src/modules/calc/accounting';
import {
  calcMaintenanceMarginFromNotional,
  calcTotalMaintenanceMargin,
} from '../../src/modules/calc/maintenanceMargin';
import { calcGrossPnl } from '../../src/modules/calc/fees';
import { isTpTriggeredByMark } from '../../src/modules/trader/grid/gridCalc';

describe('accounting', () => {
  it('starts testing balance at 2000', () => {
    expect(testingStartingBalance().toFixed(0)).toBe('2000');
  });

  it('equity = balance + unrealized', () => {
    expect(calcEquity('200', '15').toFixed(0)).toBe('215');
    expect(calcEquity('200', '-10').toFixed(0)).toBe('190');
  });

  it('realized profit increases balance instantly', () => {
    const next = applyRealizedTrade('200', '0', '0', '15', '0');
    expect(next.balance.toFixed(0)).toBe('215');
    expect(next.realizedPnl.toFixed(0)).toBe('15');
  });

  it('realized loss decreases balance', () => {
    const next = applyRealizedTrade('215', '15', '0', '-7', '0');
    expect(next.balance.toFixed(0)).toBe('208');
  });

  it('fees reduce balance and accumulate', () => {
    const next = applyRealizedTrade('200', '0', '0', '10', '0.4');
    expect(next.balance.toFixed(1)).toBe('209.6');
    expect(next.totalFees.toFixed(1)).toBe('0.4');
    expect(next.netPnl.toFixed(1)).toBe('9.6');
  });

  it('used / available margin', () => {
    const used = calcUsedMargin(['1000', '1000'], 10);
    expect(used.toFixed(0)).toBe('200');
    expect(calcAvailableMargin('250', used).toFixed(0)).toBe('50');
  });

  it('builds full snapshot with bracket maintenance margin', () => {
    const snap = buildAccountSnapshot({
      balance: '200',
      realizedPnl: '5',
      unrealizedPnl: '-2',
      dailyPnl: '3',
      totalFees: '0.5',
      openNotionals: ['500'],
      leverage: 10,
    });
    expect(snap.equity).toBe(new Decimal(198).toFixed(8));
    expect(new Decimal(snap.usedMargin).toFixed(0)).toBe('50');
    expect(new Decimal(snap.maintenanceMargin).toFixed(0)).toBe('2');
  });

  it('maintenance margin uses Binance brackets', () => {
    expect(calcMaintenanceMarginFromNotional('10000').toFixed(0)).toBe('40');
    expect(calcMaintenanceMarginFromNotional('60000').toFixed(0)).toBe('250');
    expect(calcTotalMaintenanceMargin(['10000', '10000']).toFixed(0)).toBe('80');
  });
});

describe('accounting reconciliation identities', () => {
  it('TEST 8/9: global balance + equity after realized and unrealized', () => {
    let bal = testingStartingBalance();
    let realized = new Decimal(0);
    let fees = new Decimal(0);
    const t1 = applyRealizedTrade(bal, realized, fees, '10', '1');
    bal = t1.balance;
    realized = t1.realizedPnl;
    fees = t1.totalFees;
    expect(bal.toFixed(0)).toBe('2009');
    expect(realized.toFixed(0)).toBe('9');
    expect(fees.toFixed(0)).toBe('1');

    const equity = calcEquity(bal, '-20');
    expect(equity.toFixed(0)).toBe('1989');

    const recon = reconcileGlobalAccounting({
      initialBalance: '2000',
      realizedNetPnl: realized,
      totalFees: fees,
      unrealizedPnl: '-20',
      actualBalance: bal,
      actualEquity: equity,
    });
    expect(recon.ok).toBe(true);
  });

  it('TEST 1: LONG TP gross PnL = qty × Δprice (no double leverage)', () => {
    const gross = calcGrossPnl('LONG', '100', '102', '1');
    expect(gross.toFixed(0)).toBe('2');
  });

  it('TEST 2: SHORT TP gross PnL', () => {
    expect(calcGrossPnl('SHORT', '100', '98', '1').toFixed(0)).toBe('2');
  });

  it('TEST 3: TP gap detection', () => {
    expect(isTpTriggeredByMark('LONG', '105', '102')).toBe(true);
    expect(isTpTriggeredByMark('SHORT', '90', '98')).toBe(true);
  });

  it('TEST 4: successive closes accumulate once each', () => {
    const a = applyRealizedTrade('2000', '0', '0', '10', '0.5');
    const b = applyRealizedTrade(a.balance, a.realizedPnl, a.totalFees, '10', '0.5');
    expect(b.realizedPnl.toFixed(1)).toBe('19.0');
    expect(b.totalFees.toFixed(1)).toBe('1.0');
  });

  it('entry fee then TP exit mirrors Grid/NearPrice ledger model', () => {
    let bal = new Decimal('2000');
    let realized = new Decimal(0);
    let fees = new Decimal(0);

    const e = applyRealizedTrade(bal, realized, fees, '0', '0.5');
    bal = e.balance;
    realized = e.realizedPnl;
    fees = e.totalFees;
    expect(realized.toFixed(1)).toBe('-0.5');

    const x = applyRealizedTrade(bal, realized, fees, '2.5', '0.5');
    bal = x.balance;
    realized = x.realizedPnl;
    fees = x.totalFees;

    expect(realized.toFixed(1)).toBe('1.5');
    expect(fees.toFixed(1)).toBe('1.0');
    expect(bal.toFixed(1)).toBe('2001.5');

    const recon = reconcileGlobalAccounting({
      initialBalance: '2000',
      realizedNetPnl: realized,
      totalFees: fees,
      unrealizedPnl: '0',
      actualBalance: bal,
      actualEquity: bal,
    });
    expect(recon.ok).toBe(true);
  });

  it('trader capital reconciles after closed trade (no open entry fees)', () => {
    const recon = reconcileTraderAccounting({
      initialCapital: '500',
      realizedNetPnl: '30.35',
      unrealizedPnl: '-26.76',
      totalFees: '1.75',
      actualCurrentCapital: '530.35',
      actualEquity: '503.59',
    });
    expect(recon.ok).toBe(true);
    expect(recon.expectedEquity).toBe(new Decimal('503.59').toFixed(8));
  });

  it('trader capital lags by open entry fees while position open', () => {
    const recon = reconcileTraderAccounting({
      initialCapital: '500',
      realizedNetPnl: '-0.20',
      unrealizedPnl: '1.00',
      totalFees: '0.20',
      actualCurrentCapital: '500',
      openEntryFees: '0.20',
    });
    expect(recon.ok).toBe(true);
  });

  it('equity does not double-count realized already in balance', () => {
    expect(calcEquity('2009', '-20').toFixed(0)).toBe('1989');
  });
});
