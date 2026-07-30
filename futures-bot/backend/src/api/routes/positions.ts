import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';

export function createPositionsRouter(db: PrismaClient): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { traderId, isOpen } = req.query;
    const positions = await db.position.findMany({
      where: {
        ...(traderId != null ? { traderId: String(traderId) } : {}),
        ...(isOpen != null ? { isOpen: isOpen === 'true' } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, data: positions });
  });

  return router;
}

export function createTradesRouter(db: PrismaClient): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { traderId, symbol } = req.query;
    const trades = await db.trade.findMany({
      where: {
        ...(traderId != null ? { traderId: String(traderId) } : {}),
        ...(symbol != null ? { symbol: String(symbol) } : {}),
      },
      orderBy: { tradeTime: 'desc' },
      take: 200,
    });
    res.json({ success: true, data: trades });
  });

  return router;
}
