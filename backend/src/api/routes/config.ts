import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

export function createConfigRouter(db: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    let config = await db.configuration.findUnique({ where: { id: 'singleton' } });
    if (config == null) {
      config = await db.configuration.create({ data: { id: 'singleton' } });
    }
    res.json({ success: true, data: config });
  });

  router.patch('/', async (req: Request, res: Response) => {
    const allowed = [
      'maxTraders', 'initialCapital', 'positionSize', 'leverage',
      'marginMode', 'hedgeDistance', 'hedgeTpPercent', 'hedgeSlPercent',
      'shortTpPercent', 'refreshInterval', 'retryLimit', 'feeRate',
      'slippage', 'isPaused',
    ] as const;

    const update: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) {
        update[key] = req.body[key];
      }
    }

    const config = await db.configuration.upsert({
      where: { id: 'singleton' },
      update,
      create: { id: 'singleton', ...update },
    });

    res.json({ success: true, data: config });
  });

  return router;
}
