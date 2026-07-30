import { Router } from 'express';
import type { TraderManager } from '../../modules/trader-manager/TraderManager';
import type { PrismaClient } from '@prisma/client';

export function createTradersRouter(traderManager: TraderManager, db: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const traders = await db.trader.findMany({
      orderBy: { createdAt: 'desc' },
      include: { statistics: true },
    });
    res.json({ success: true, data: traders });
  });

  router.get('/active', (_req, res) => {
    res.json({ success: true, data: traderManager.getTraderSummary() });
  });

  router.get('/:id', async (req, res) => {
    const trader = await db.trader.findUnique({
      where: { id: req.params.id },
      include: { orders: { orderBy: { createdAt: 'desc' }, take: 50 }, statistics: true, positions: true, trades: { orderBy: { tradeTime: 'desc' }, take: 50 } },
    });
    if (trader == null) {
      res.status(404).json({ success: false, error: 'Trader not found' });
      return;
    }
    res.json({ success: true, data: trader });
  });

  router.post('/pause', async (_req, res) => {
    await traderManager.pause();
    res.json({ success: true, message: 'All traders paused' });
  });

  router.post('/resume', async (_req, res) => {
    await traderManager.resume();
    res.json({ success: true, message: 'All traders resumed' });
  });

  router.post('/emergency-stop', async (_req, res) => {
    await traderManager.emergencyStop();
    res.json({ success: true, message: 'Emergency stop executed' });
  });

  return router;
}
