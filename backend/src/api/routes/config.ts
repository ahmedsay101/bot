import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { TraderManager } from '../../modules/trader-manager/TraderManager';

export function createConfigRouter(db: PrismaClient, traderManager?: TraderManager): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    let config = await db.configuration.findUnique({ where: { id: 'singleton' } });
    if (config == null) {
      config = await db.configuration.create({ data: { id: 'singleton' } });
    }
    // Prefer live engine values when available
    if (traderManager != null) {
      const runtime = traderManager.getRuntimeConfig();
      res.json({
        success: true,
        data: {
          ...config,
          maxTraders: runtime.maxTraders,
          leverage: runtime.leverage,
          hedgeDistance: runtime.hedgeDistance,
          hedgeTpPercent: runtime.hedgeTpPercent,
          hedgeSlPercent: runtime.hedgeSlPercent,
          shortTpPercent: runtime.shortTpPercent,
          feeRate: runtime.feeRate,
          slippage: runtime.slippage,
          refreshInterval: runtime.refreshInterval,
          retryLimit: runtime.retryLimit,
          marginMode: runtime.marginMode,
          initialCapital: runtime.initialCapital,
          positionSize: runtime.positionSize,
        },
      });
      return;
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

    // Hot-apply to running engine (no restart required)
    if (traderManager != null) {
      traderManager.applyRuntimeConfig(update);
      if (typeof update.isPaused === 'boolean') {
        if (update.isPaused) await traderManager.pause();
        else await traderManager.resume();
      }
    }

    res.json({ success: true, data: config });
  });

  return router;
}
