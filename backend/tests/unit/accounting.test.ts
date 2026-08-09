import Decimal from 'decimal.js';
import {
  applyRealizedTrade,
  buildAccountSnapshot,
  calcEquity,
  calcUsedMargin,
  calcAvailableMargin,
  testingStartingBalance,
} from '../../src/modules/calc/accounting';
import {
  calcMaintenanceMarginFromNotional,
  calcTotalMaintenanceMargin,
} from '../../src/modules/calc/maintenanceMargin';

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
    // 500 × 0.004 − 0 = 2
    expect(new Decimal(snap.maintenanceMargin).toFixed(0)).toBe('2');
  });

  it('maintenance margin uses Binance brackets', () => {
    expect(calcMaintenanceMarginFromNotional('10000').toFixed(0)).toBe('40');
    // 60000 × 0.005 − 50 = 250
    expect(calcMaintenanceMarginFromNotional('60000').toFixed(0)).toBe('250');
    expect(calcTotalMaintenanceMargin(['10000', '10000']).toFixed(0)).toBe('80');
  });
});
