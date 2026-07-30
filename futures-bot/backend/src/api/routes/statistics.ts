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

  router.get('/summary', (_req, res) => {
    res.json({
      success: true,
      data: {
        activeTraders: traderManager.getActiveTraderCount(),
        topGainers: traderManager.getTopGainers().slice(0, 10),
        totalRealizedPnl: traderManager.getTotalRealizedPnl(),
        totalUnrealizedPnl: traderManager.getTotalUnrealizedPnl(),
      },
    });
  });

  return router;
}
