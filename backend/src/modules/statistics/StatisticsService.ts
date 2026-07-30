import Decimal from 'decimal.js';
import type { PrismaClient } from '@prisma/client';
import type { BinanceClient } from '../binance/client';
import { createContextLogger } from '../logger';

const log = createContextLogger('StatisticsService');

export interface GlobalStats {
  totalTraders: number;
  activeTraders: number;
  completedTraders: number;
  totalRealizedPnl: string;
  totalFees: string;
  dailyPnl: string;
  winRate: string;
  // Equity breakdown
  totalEquity: string;
  equityPerTrader: string;
  positionEquity: string;
  positionNotional: string;
  maxTraders: number;
  leverage: number;
  tradingMode: string;
}

export interface TraderStats {
  traderId: string;
  symbol: string;
  mode: string;
  shortEntryPrice: string;
  shortExitPrice: string | null;
  totalHedgeLevels: number;
  hedgeWins: number;
  hedgeLosses: number;
  totalFees: string;
  realizedPnl: string;
  winRate: string;
}

export class StatisticsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly binanceClient: BinanceClient,
    private readonly mode: 'LIVE' | 'SIMULATION',
  ) {}

  async getGlobalStatistics(): Promise<GlobalStats> {
    const [traders, completedStats] = await Promise.all([
      this.db.trader.findMany({ select: { status: true, realizedPnl: true } }),
      this.db.traderStatistics.findMany({ select: { realizedPnl: true, totalFees: true, hedgeWins: true, hedgeLosses: true } }),
    ]);

    const activeTraders = traders.filter((t) => t.status === 'ACTIVE' || t.status === 'INITIALIZING').length;
    const completedTraders = traders.filter((t) => t.status === 'COMPLETED').length;

    const totalRealizedPnl = traders.reduce(
      (acc, t) => acc.plus(t.realizedPnl),
      new Decimal(0),
    );

    const totalFees = completedStats.reduce(
      (acc, s) => acc.plus(s.totalFees),
      new Decimal(0),
    );

    const totalWins = completedStats.reduce((acc, s) => acc + s.hedgeWins, 0);
    const totalLosses = completedStats.reduce((acc, s) => acc + s.hedgeLosses, 0);
    const totalHedges = totalWins + totalLosses;
    const winRate = totalHedges > 0
      ? new Decimal(totalWins).div(totalHedges).mul(100).toFixed(2)
      : '0';

    // Daily PnL: sum of realized PnL from trades today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayTrades = await this.db.trade.findMany({
      where: { createdAt: { gte: todayStart } },
      select: { realizedPnl: true },
    });
    const dailyPnl = todayTrades.reduce(
      (acc, t) => acc.plus(t.realizedPnl),
      new Decimal(0),
    );

    const cfg = await this.db.configuration.findUnique({ where: { id: 'singleton' } });
    const maxTraders = cfg?.maxTraders ?? 1;
    const leverage = cfg?.leverage ?? 10;

    let totalEquity: Decimal;
    if (this.mode === 'SIMULATION') {
      totalEquity = new Decimal('200').plus(totalRealizedPnl);
    } else {
      try {
        const balances = await this.binanceClient.getAccountBalance();
        const usdt = balances.find((b) => b.asset === 'USDT');
        totalEquity = usdt != null ? new Decimal(usdt.balance) : new Decimal(0);
      } catch {
        totalEquity = new Decimal(0);
      }
    }

    const equityPerTrader = maxTraders > 0 ? totalEquity.div(maxTraders) : totalEquity;
    const positionEquity = equityPerTrader.div(2);
    const positionNotional = positionEquity.mul(leverage);

    const stats: GlobalStats = {
      totalTraders: traders.length,
      activeTraders,
      completedTraders,
      totalRealizedPnl: totalRealizedPnl.toFixed(4),
      totalFees: totalFees.toFixed(4),
      dailyPnl: dailyPnl.toFixed(4),
      winRate,
      totalEquity: totalEquity.toFixed(2),
      equityPerTrader: equityPerTrader.toFixed(2),
      positionEquity: positionEquity.toFixed(2),
      positionNotional: positionNotional.toFixed(2),
      maxTraders,
      leverage,
      tradingMode: this.mode,
    };

    // Persist to global statistics table
    await this.db.globalStatistics.upsert({
      where: { id: 'singleton' },
      update: {
        totalTraders: traders.length,
        activeTraders,
        completedTraders,
        totalRealizedPnl: totalRealizedPnl.toFixed(8),
        totalFees: totalFees.toFixed(8),
        dailyPnl: dailyPnl.toFixed(8),
        winRate,
        lastUpdated: new Date(),
      },
      create: {
        id: 'singleton',
        totalTraders: traders.length,
        activeTraders,
        completedTraders,
        totalRealizedPnl: totalRealizedPnl.toFixed(8),
        totalFees: totalFees.toFixed(8),
        dailyPnl: dailyPnl.toFixed(8),
        winRate,
      },
    });

    return stats;
  }

  async getTraderStatistics(traderId: string): Promise<TraderStats | null> {
    const stats = await this.db.traderStatistics.findUnique({ where: { traderId } });
    if (stats == null) return null;

    const totalHedges = stats.hedgeWins + stats.hedgeLosses;
    const winRate = totalHedges > 0
      ? new Decimal(stats.hedgeWins).div(totalHedges).mul(100).toFixed(2)
      : '0';

    return {
      traderId: stats.traderId,
      symbol: stats.symbol,
      mode: stats.mode,
      shortEntryPrice: stats.shortEntryPrice,
      shortExitPrice: stats.shortExitPrice,
      totalHedgeLevels: stats.totalHedgeLevels,
      hedgeWins: stats.hedgeWins,
      hedgeLosses: stats.hedgeLosses,
      totalFees: stats.totalFees,
      realizedPnl: stats.realizedPnl,
      winRate,
    };
  }

  async refreshStatistics(): Promise<void> {
    try {
      await this.getGlobalStatistics();
    } catch (err) {
      log.error('Failed to refresh statistics', { error: String(err) });
    }
  }
}
