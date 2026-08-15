import Decimal from 'decimal.js';
import {
  calcBalanceRange24h,
  selectExpiredBalanceSnapshotIds,
  BALANCE_HISTORY_WINDOW_MS,
} from '../../src/modules/calc/balanceHistory';
import { applyRealizedTrade } from '../../src/modules/calc/accounting';

const HOUR = 60 * 60 * 1000;

describe('balanceHistory 24h high/low', () => {
  const now = Date.parse('2026-08-16T18:30:00.000Z');

  it('basic series: high 212 low 198', () => {
    const history = [
      { recordedAt: now - 5 * HOUR, balance: '200' },
      { recordedAt: now - 4 * HOUR, balance: '205' },
      { recordedAt: now - 3 * HOUR, balance: '198' },
      { recordedAt: now - 2 * HOUR, balance: '212' },
      { recordedAt: now - 1 * HOUR, balance: '207' },
    ];
    const range = calcBalanceRange24h('207', history, now);
    expect(range.highestBalance24h).toBe(new Decimal(212).toFixed(8));
    expect(range.lowestBalance24h).toBe(new Decimal(198).toFixed(8));
    expect(range.currentBalance).toBe(new Decimal(207).toFixed(8));
  });

  it('new high updates highest', () => {
    const history = [
      { recordedAt: now - 2 * HOUR, balance: '210' },
      { recordedAt: now - 1 * HOUR, balance: '195' },
    ];
    const range = calcBalanceRange24h('215', history, now);
    expect(range.highestBalance24h).toBe(new Decimal(215).toFixed(8));
    expect(range.lowestBalance24h).toBe(new Decimal(195).toFixed(8));
  });

  it('new low updates lowest', () => {
    const history = [
      { recordedAt: now - 2 * HOUR, balance: '210' },
      { recordedAt: now - 1 * HOUR, balance: '195' },
    ];
    const range = calcBalanceRange24h('190', history, now);
    expect(range.highestBalance24h).toBe(new Decimal(210).toFixed(8));
    expect(range.lowestBalance24h).toBe(new Decimal(190).toFixed(8));
  });

  it('excludes snapshots older than 24h', () => {
    const history = [
      { recordedAt: now - 25 * HOUR, balance: '300' },
      { recordedAt: now - 20 * HOUR, balance: '200' },
      { recordedAt: now - 10 * HOUR, balance: '250' },
      { recordedAt: now - 2 * HOUR, balance: '220' },
    ];
    const range = calcBalanceRange24h('220', history, now);
    expect(range.highestBalance24h).toBe(new Decimal(250).toFixed(8));
    expect(range.lowestBalance24h).toBe(new Decimal(200).toFixed(8));
  });

  it('exact boundary: snapshot at now−24h is included; 1ms before is excluded', () => {
    const windowStart = now - BALANCE_HISTORY_WINDOW_MS;
    const atBoundary = {
      recordedAt: windowStart,
      balance: '400',
    };
    const justBefore = {
      recordedAt: windowStart - 1,
      balance: '50',
    };
    const mid = { recordedAt: now - HOUR, balance: '100' };

    const withBoundary = calcBalanceRange24h('100', [justBefore, atBoundary, mid], now);
    expect(withBoundary.highestBalance24h).toBe(new Decimal(400).toFixed(8));
    expect(withBoundary.lowestBalance24h).toBe(new Decimal(100).toFixed(8));

    const onlyBefore = calcBalanceRange24h('100', [justBefore], now);
    expect(onlyBefore.highestBalance24h).toBe(new Decimal(100).toFixed(8));
    expect(onlyBefore.lowestBalance24h).toBe(new Decimal(100).toFixed(8));
  });

  it('insufficient history defaults high/low to current', () => {
    const range = calcBalanceRange24h('200', [], now);
    expect(range.highestBalance24h).toBe(new Decimal(200).toFixed(8));
    expect(range.lowestBalance24h).toBe(new Decimal(200).toFixed(8));
  });

  it('restart reconstruction uses persisted history', () => {
    // Simulate reload: same history points loaded from DB
    const history = [
      { recordedAt: now - 6 * HOUR, balance: '200.00000000' },
      { recordedAt: now - 3 * HOUR, balance: '218.73000000' },
      { recordedAt: now - HOUR, balance: '194.18000000' },
    ];
    const range = calcBalanceRange24h('205.42', history, now);
    expect(range.highestBalance24h).toBe(new Decimal('218.73').toFixed(8));
    expect(range.lowestBalance24h).toBe(new Decimal('194.18').toFixed(8));
  });

  it('fee-driven balance drop affects low', () => {
    let bal = new Decimal('200');
    let realized = new Decimal(0);
    let fees = new Decimal(0);
    const next = applyRealizedTrade(bal, realized, fees, '0', '0.40');
    bal = next.balance;
    const history = [
      { recordedAt: now - HOUR, balance: '200' },
      { recordedAt: now - 1, balance: bal.toFixed(8) },
    ];
    const range = calcBalanceRange24h(bal, history, now);
    expect(range.highestBalance24h).toBe(new Decimal(200).toFixed(8));
    expect(range.lowestBalance24h).toBe(new Decimal('199.6').toFixed(8));
  });

  it('Decimal precision — no float drift', () => {
    const history = [
      { recordedAt: now - 2 * HOUR, balance: '200.00000001' },
      { recordedAt: now - HOUR, balance: '200.00000003' },
    ];
    const range = calcBalanceRange24h('200.00000002', history, now);
    expect(range.highestBalance24h).toBe('200.00000003');
    expect(range.lowestBalance24h).toBe('200.00000001');
  });

  it('cleanup keeps newest pre-window anchor only', () => {
    const windowStart = now - BALANCE_HISTORY_WINDOW_MS;
    const ids = selectExpiredBalanceSnapshotIds(
      [
        { id: 'a', recordedAt: windowStart - 3 * HOUR },
        { id: 'b', recordedAt: windowStart - 2 * HOUR },
        { id: 'c', recordedAt: windowStart - 1 },
        { id: 'd', recordedAt: windowStart + HOUR },
      ],
      now,
    );
    expect(ids).toEqual(['a', 'b']);
  });
});
