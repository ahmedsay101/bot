import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';

export function createOrdersRouter(db: PrismaClient): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { traderId, status, symbol } = req.query;
    const orders = await db.order.findMany({
      where: {
        ...(traderId != null ? { traderId: String(traderId) } : {}),
        ...(status != null ? { status: String(status) as import('@prisma/client').OrderStatus } : {}),
        ...(symbol != null ? { symbol: String(symbol) } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, data: orders });
  });

  router.get('/:id', async (req, res) => {
    const order = await db.order.findUnique({ where: { id: req.params.id } });
    if (order == null) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }
    res.json({ success: true, data: order });
  });

  return router;
}
