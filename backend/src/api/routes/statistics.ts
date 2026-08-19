import { Router } from 'express';
import type { StatisticsService } from '../../modules/statistics/StatisticsService';
import type { TraderManager } from '../../modules/trader-manager/TraderManager';

export function createStatisticsRouter(
  statisticsService: StatisticsService,
  traderManager: TraderManager,
): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const runtime = traderManager.getRuntimeConfig();
    const stats = await statisticsService.getGlobalStatistics(
      traderManager.getTotalUnrealizedPnl(),
      [],
      { maxTraders: runtime.maxTraders, leverage: runtime.leverage },
    );
    res.json({ success: true, data: stats });
  });

  router.get('/traders/:id', async (req, res) => {
    const stats = await statisticsService.getTraderStatistics(req.params.id);
    if (stats == null) {
      res.status(404).json({ success: false, error: 'Statistics not found' });
      return;
    }
    res.json({ success: true, data: stats });
  });

  router.get('/summary', async (_req, res) => {
    const runtime = traderManager.getRuntimeConfig();
    const stats = await statisticsService.getGlobalStatistics(
      traderManager.getTotalUnrealizedPnl(),
      [],
      { maxTraders: runtime.maxTraders, leverage: runtime.leverage },
    );
    const maxTraders = traderManager.getMaxTraders();
    res.json({
      success: true,
      data: {
        balance: stats.balance,
        equity: stats.equity,
        dailyPnl: stats.dailyPnl,
        totalRealizedPnl: stats.totalRealizedPnl,
        grossRealizedPnl: stats.grossRealizedPnl,
        netRealizedPnl: stats.netRealizedPnl,
        totalFees: stats.totalFees,
        currentBalance: stats.currentBalance,
        highestBalance24h: stats.highestBalance24h,
        lowestBalance24h: stats.lowestBalance24h,
        totalUnrealizedPnl: traderManager.getTotalUnrealizedPnl(),
        totalPnl: stats.totalPnl,
        openPositionValue: stats.openPositionValue,
        usedMargin: stats.usedMargin,
        availableMargin: stats.availableMargin,
        openPositions: traderManager.getOpenPositionCount(),
        activeTraders: traderManager.getOccupiedSlots(),
        maxTraders,
        topGainers: traderManager.getTopGainers().slice(0, 20),
        tradingMode: stats.tradingMode,
        botStatus: 'RUNNING',
        traderBehavior: runtime.traderBehavior ?? 'grid_directional',
        equityPerTrader: stats.equityPerTrader,
        positionNotional: stats.positionNotional,
        leverage: stats.leverage,
        traders: traderManager.getTraderSummary(),
      },
    });
  });

  return router;
}
