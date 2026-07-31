import Decimal from 'decimal.js';
import type { PrismaClient } from '@prisma/client';
import type { EquityService } from '../calc/EquityService';
import { calcAllocation, calcTotalPnl } from '../calc/allocation';
import { createContextLogger } from '../logger';

const log = createContextLogger('StatisticsService');

export interface GlobalStats {
  totalTraders: number;
  activeTraders: number;
  completedTraders: number;
  totalRealizedPnl: string;
  totalUnrealizedPnl: string;
  totalPnl: string;
  totalFees: string;
  dailyPnl: string;
  winRate: string;
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
    private readonly equityService: EquityService,
    private readonly mode: 'LIVE' | 'SIMULATION',
  ) {}

  async getGlobalStatistics(): Promise<GlobalStats> {
    const [traders, completedStats] = await Promise.all([
      this.db.trader.findMany({ select: { status: true, realizedPnl: true, unrealizedPnl: true } }),
      this.db.traderStatistics.findMany({ select: { realizedPnl: true, totalFees: true, hedgeWins: true, hedgeLosses: true } }),
    ]);

    const activeTraders = traders.filter((t) => t.status === 'ACTIVE' || t.status === 'INITIALIZING').length;
    const completedTraders = traders.filter((t) => t.status === 'COMPLETED').length;

    const totalRealizedPnl = traders.reduce(
      (acc, t) => acc.plus(t.realizedPnl),
      new Decimal(0),
    );

    const totalUnrealizedPnl = traders
      .filter((t) => t.status === 'ACTIVE' || t.status === 'INITIALIZING' || t.status === 'PAUSED')
      .reduce((acc, t) => acc.plus(t.unrealizedPnl), new Decimal(0));

    const totalPnl = calcTotalPnl(totalRealizedPnl, totalUnrealizedPnl);

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

    const totalEquity = await this.equityService.getTotalEquity();
    const allocation = calcAllocation(totalEquity, maxTraders, leverage);

    const stats: GlobalStats = {
      totalTraders: traders.length,
      activeTraders,
      completedTraders,
      totalRealizedPnl: totalRealizedPnl.toFixed(4),
      totalUnrealizedPnl: totalUnrealizedPnl.toFixed(4),
      totalPnl: totalPnl.toFixed(4),
      totalFees: totalFees.toFixed(4),
      dailyPnl: dailyPnl.toFixed(4),
      winRate,
      totalEquity: allocation.totalEquity.toFixed(2),
      equityPerTrader: allocation.traderEquity.toFixed(2),
      positionEquity: allocation.positionAllocation.toFixed(2),
      positionNotional: allocation.positionNotional.toFixed(2),
      maxTraders,
      leverage,
      tradingMode: this.mode,
    };

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
