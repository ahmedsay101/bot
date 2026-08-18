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
    if (traderManager != null) {
      const runtime = traderManager.getRuntimeConfig();
      res.json({
        success: true,
        data: {
          ...config,
          maxTraders: runtime.maxTraders,
          leverage: runtime.leverage,
          traderLifetimeHours: runtime.traderLifetimeHours,
          takeProfitPercent: runtime.takeProfitPercent,
          stopLossPercent: runtime.stopLossPercent,
          startingSide: runtime.startingSide,
          capitalSteps: runtime.capitalSteps,
          switchPositionOnTakeProfit: runtime.switchPositionOnTakeProfit,
          traderBehavior: runtime.traderBehavior,
          gridLevelsPerSide: runtime.gridLevelsPerSide,
          gridDistancePercent: runtime.gridDistancePercent,
          traderTakeProfitPercent: runtime.traderTakeProfitPercent,
          traderMaxLifetimeHours: runtime.traderMaxLifetimeHours,
          feeRate: runtime.feeRate,
          makerFeeRate: runtime.makerFeeRate,
          takerFeeRate: runtime.takerFeeRate,
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
      'marginMode', 'traderLifetimeHours', 'takeProfitPercent', 'stopLossPercent',
      'startingSide', 'capitalSteps', 'switchPositionOnTakeProfit',
      'traderBehavior', 'gridLevelsPerSide', 'gridDistancePercent',
      'traderTakeProfitPercent', 'traderMaxLifetimeHours',
      'refreshInterval', 'retryLimit', 'feeRate',
      'makerFeeRate', 'takerFeeRate',
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

    if (traderManager != null && Object.keys(update).length > 0) {
      traderManager.applyRuntimeConfig(update);
    }

    res.json({ success: true, data: config });
  });

  return router;
}
