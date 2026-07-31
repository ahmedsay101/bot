import { Router } from 'express';
import type { StatisticsService } from '../../modules/statistics/StatisticsService';
import type { TraderManager } from '../../modules/trader-manager/TraderManager';

export function createStatisticsRouter(
  statisticsService: StatisticsService,
  traderManager: TraderManager,
): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const stats = await statisticsService.getGlobalStatistics();
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
    const stats = await statisticsService.getGlobalStatistics();
    res.json({
      success: true,
      data: {
        activeTraders: traderManager.getActiveTraderCount(),
        maxTraders: stats.maxTraders,
        topGainers: traderManager.getTopGainers().slice(0, 20),
        totalEquity: stats.totalEquity,
        totalPnl: stats.totalPnl,
        totalRealizedPnl: traderManager.getTotalRealizedPnl(),
        totalUnrealizedPnl: traderManager.getTotalUnrealizedPnl(),
        tradingMode: stats.tradingMode,
        equityPerTrader: stats.equityPerTrader,
        positionNotional: stats.positionNotional,
        leverage: stats.leverage,
      },
    });
  });

  return router;
}
