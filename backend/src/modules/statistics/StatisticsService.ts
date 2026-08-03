import Decimal from 'decimal.js';
import type { PrismaClient } from '@prisma/client';
import type { AccountLedger } from '../calc/AccountLedger';
import { calcAllocation } from '../calc/allocation';
import { createContextLogger } from '../logger';

const log = createContextLogger('StatisticsService');

export interface GlobalStats {
  totalTraders: number;
  activeTraders: number;
  completedTraders: number;
  balance: string;
  equity: string;
  totalRealizedPnl: string;
  totalUnrealizedPnl: string;
  totalPnl: string;
  dailyPnl: string;
  openPositionValue: string;
  usedMargin: string;
  availableMargin: string;
  totalFees: string;
  winRate: string;
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
    private readonly accountLedger: AccountLedger,
    private readonly mode: 'LIVE' | 'SIMULATION',
  ) {}

  async getGlobalStatistics(
    liveUnrealized = '0',
    openNotionals: string[] = [],
    runtime?: { maxTraders?: number; leverage?: number },
  ): Promise<GlobalStats> {
    const [traders, completedStats] = await Promise.all([
      this.db.trader.findMany({ select: { status: true, realizedPnl: true, unrealizedPnl: true } }),
      this.db.traderStatistics.findMany({ select: { totalFees: true, hedgeWins: true, hedgeLosses: true } }),
    ]);

    const activeTraders = traders.filter((t) => t.status === 'ACTIVE' || t.status === 'INITIALIZING').length;
    const completedTraders = traders.filter((t) => t.status === 'COMPLETED').length;

    const dbUnrealized = traders
      .filter((t) => t.status === 'ACTIVE' || t.status === 'INITIALIZING' || t.status === 'PAUSED')
      .reduce((acc, t) => acc.plus(t.unrealizedPnl), new Decimal(0));

    const unrealized = liveUnrealized !== '0' ? liveUnrealized : dbUnrealized.toFixed(8);

    const cfg = await this.db.configuration.findUnique({ where: { id: 'singleton' } });
    const maxTraders = runtime?.maxTraders ?? cfg?.maxTraders ?? Number(process.env.MAX_TRADERS ?? 1);
    const leverage = runtime?.leverage ?? cfg?.leverage ?? Number(process.env.LEVERAGE ?? 10);

    const snap = await this.accountLedger.getSnapshot({
      unrealizedPnl: unrealized,
      openNotionals,
      leverage,
    });

    const totalWins = completedStats.reduce((acc, s) => acc + s.hedgeWins, 0);
    const totalLosses = completedStats.reduce((acc, s) => acc + s.hedgeLosses, 0);
    const totalHedges = totalWins + totalLosses;
    const winRate = totalHedges > 0
      ? new Decimal(totalWins).div(totalHedges).mul(100).toFixed(2)
      : '0';

    const allocation = calcAllocation(snap.balance, maxTraders, leverage);
    const totalPnl = new Decimal(snap.realizedPnl).plus(snap.unrealizedPnl);

    const stats: GlobalStats = {
      totalTraders: traders.length,
      activeTraders,
      completedTraders,
      balance: new Decimal(snap.balance).toFixed(2),
      equity: new Decimal(snap.equity).toFixed(2),
      totalRealizedPnl: new Decimal(snap.realizedPnl).toFixed(4),
      totalUnrealizedPnl: new Decimal(snap.unrealizedPnl).toFixed(4),
      totalPnl: totalPnl.toFixed(4),
      dailyPnl: new Decimal(snap.dailyPnl).toFixed(4),
      openPositionValue: new Decimal(snap.openPositionValue).toFixed(2),
      usedMargin: new Decimal(snap.usedMargin).toFixed(2),
      availableMargin: new Decimal(snap.availableMargin).toFixed(2),
      totalFees: new Decimal(snap.totalFees).toFixed(4),
      winRate,
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
        totalRealizedPnl: snap.realizedPnl,
        totalFees: snap.totalFees,
        dailyPnl: snap.dailyPnl,
        winRate,
        lastUpdated: new Date(),
      },
      create: {
        id: 'singleton',
        totalTraders: traders.length,
        activeTraders,
        completedTraders,
        totalRealizedPnl: snap.realizedPnl,
        totalFees: snap.totalFees,
        dailyPnl: snap.dailyPnl,
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
