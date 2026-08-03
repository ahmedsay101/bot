import { resetTradingData } from '../../src/modules/db/resetTradingData';

describe('resetTradingData', () => {
  it('deletes trading tables and resets ledger + global stats', async () => {
    const calls: string[] = [];
    const db = {
      $transaction: jest.fn(async (ops: Promise<{ count: number }>[]) => {
        calls.push('transaction');
        return Promise.all(ops);
      }),
      trade: { deleteMany: jest.fn(async () => ({ count: 2 })) },
      order: { deleteMany: jest.fn(async () => ({ count: 5 })) },
      position: { deleteMany: jest.fn(async () => ({ count: 1 })) },
      traderStatistics: { deleteMany: jest.fn(async () => ({ count: 1 })) },
      trader: { deleteMany: jest.fn(async () => ({ count: 3 })) },
      appLog: { deleteMany: jest.fn(async () => ({ count: 10 })) },
      accountLedger: {
        upsert: jest.fn(async ({ update }: { update: { balance: string } }) => {
          calls.push(`ledger:${update.balance}`);
          return {};
        }),
      },
      globalStatistics: {
        upsert: jest.fn(async () => {
          calls.push('global');
          return {};
        }),
      },
    };

    const result = await resetTradingData(db as never);

    expect(result).toEqual({
      traders: 3,
      orders: 5,
      positions: 1,
      trades: 2,
      statistics: 1,
      logs: 10,
    });
    expect(db.accountLedger.upsert).toHaveBeenCalled();
    expect(db.globalStatistics.upsert).toHaveBeenCalled();
    expect(calls).toContain('transaction');
    expect(calls.some((c) => c.startsWith('ledger:'))).toBe(true);
  });
});
