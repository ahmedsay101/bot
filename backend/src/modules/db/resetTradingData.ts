import type { PrismaClient } from '@prisma/client';
import { testingStartingBalance } from '../calc/accounting';
import { createContextLogger } from '../logger';

const log = createContextLogger('ResetTradingData');

export interface ResetTradingDataResult {
  traders: number;
  orders: number;
  positions: number;
  trades: number;
  statistics: number;
  logs: number;
}

/**
 * Wipe all trading history so the next boot starts fresh.
 * Keeps Configuration (boot re-syncs it from env).
 * Resets testing AccountLedger to 200 USDT and clears GlobalStatistics.
 */
export async function resetTradingData(db: PrismaClient): Promise<ResetTradingDataResult> {
  // Children first (FK → Trader)
  const [trades, orders, positions, statistics, traders, logs] = await db.$transaction([
    db.trade.deleteMany({}),
    db.order.deleteMany({}),
    db.position.deleteMany({}),
    db.traderStatistics.deleteMany({}),
    db.trader.deleteMany({}),
    db.appLog.deleteMany({}),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const starting = testingStartingBalance().toFixed(8);

  await db.accountLedger.upsert({
    where: { id: 'singleton' },
    update: {
      balance: starting,
      realizedPnl: '0',
      totalFees: '0',
      dailyPnl: '0',
      dailyPnlDate: today,
    },
    create: {
      id: 'singleton',
      balance: starting,
      realizedPnl: '0',
      totalFees: '0',
      dailyPnl: '0',
      dailyPnlDate: today,
    },
  });

  await db.globalStatistics.upsert({
    where: { id: 'singleton' },
    update: {
      totalTraders: 0,
      activeTraders: 0,
      completedTraders: 0,
      totalRealizedPnl: '0',
      totalFees: '0',
      dailyPnl: '0',
      winRate: '0',
      lastUpdated: new Date(),
    },
    create: {
      id: 'singleton',
      totalTraders: 0,
      activeTraders: 0,
      completedTraders: 0,
      totalRealizedPnl: '0',
      totalFees: '0',
      dailyPnl: '0',
      winRate: '0',
    },
  });

  const result: ResetTradingDataResult = {
    traders: traders.count,
    orders: orders.count,
    positions: positions.count,
    trades: trades.count,
    statistics: statistics.count,
    logs: logs.count,
  };

  log.warn('[LIFECYCLE] DB_RESET — trading history cleared; starting fresh', result);
  return result;
}
