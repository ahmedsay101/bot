import Decimal from 'decimal.js';
import type { PrismaClient } from '@prisma/client';
import type { BinanceClient } from '../binance/client';
import type { TraderMode } from '../../types';
import { calcAllocation, calcTestingEquity, type AllocationBreakdown } from './allocation';
import { createContextLogger } from '../logger';

const log = createContextLogger('EquityService');

/**
 * Single source of truth for total equity and position allocation.
 * Live: Binance Futures USDT wallet balance.
 * Testing: 200 USDT + sum of realized PnL.
 */
export class EquityService {
  constructor(
    private readonly db: PrismaClient,
    private readonly binanceClient: BinanceClient,
    private readonly mode: TraderMode,
  ) {}

  async getTotalRealizedPnl(): Promise<Decimal> {
    const traders = await this.db.trader.findMany({ select: { realizedPnl: true } });
    return traders.reduce((acc, t) => acc.plus(t.realizedPnl), new Decimal(0));
  }

  async getTotalEquity(): Promise<Decimal> {
    if (this.mode === 'SIMULATION') {
      const realized = await this.getTotalRealizedPnl();
      return calcTestingEquity(realized);
    }

    try {
      const balances = await this.binanceClient.getAccountBalance();
      const usdt = balances.find((b) => b.asset === 'USDT');
      return usdt != null ? new Decimal(usdt.balance) : new Decimal(0);
    } catch (err) {
      log.error('Failed to fetch Binance equity', { error: String(err) });
      return new Decimal(0);
    }
  }

  async getAllocation(maxTraders: number, leverage: number): Promise<AllocationBreakdown> {
    const totalEquity = await this.getTotalEquity();
    return calcAllocation(totalEquity, maxTraders, leverage);
  }
}
