import { CONFIG } from '../core/config.js';
import { BalanceModel, PositionModel } from '../models/index.js';
import { env } from '../core/env.js';
import { scoped } from '../utils/logger.js';

const log = scoped('PORTFOLIO');

export interface AllocationInfo {
  totalBalance: number;
  selectedSymbols: string[];
  marginPerSymbol: number;
}

export class PortfolioService {
  /** Allocate margin equally across selected symbols, per spec. */
  allocate(selected: string[], totalBalance?: number): AllocationInfo {
    const cfg = CONFIG();
    const total = totalBalance ?? cfg.trading.totalBalance;
    const n = Math.max(1, selected.length);
    return {
      totalBalance: total,
      selectedSymbols: selected,
      marginPerSymbol: total / n,
    };
  }

  async snapshot(opts: { balance: number; equity: number; unrealizedPnl: number; marginUsed: number; feesPaid: number }): Promise<void> {
    try {
      await BalanceModel.create({ mode: env.MODE, ts: new Date(), ...opts });
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'balance snapshot failed');
    }
  }

  async openPositionCount(): Promise<number> {
    return PositionModel.countDocuments({ mode: env.MODE });
  }
}
