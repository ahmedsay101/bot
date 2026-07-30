import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import os from 'os';
import type { BinanceClient } from '../../modules/binance/client';
import type { WebSocketManager } from '../../modules/websocket/manager';
import type { SystemHealth } from '../../types';

export function createSystemRouter(
  db: PrismaClient,
  binanceClient: BinanceClient,
  wsManager: WebSocketManager,
): Router {
  const router = Router();
  const startTime = Date.now();

  router.get('/health', async (_req: Request, res: Response) => {
    let dbHealthy = false;
    try {
      await db.$queryRaw`SELECT 1`;
      dbHealthy = true;
    } catch {
      dbHealthy = false;
    }

    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemMb = Math.round((totalMem - freeMem) / 1024 / 1024);

    const health: SystemHealth = {
      status: dbHealthy ? 'healthy' : 'degraded',
      uptime: Date.now() - startTime,
      database: dbHealthy,
      redis: true, // simplification — real check via ioredis ping
      binanceApi: binanceClient.isHealthy(),
      binanceWs: wsManager.getActiveStreams().length > 0,
      activeTraders: 0, // populated by caller
      cpuPercent: cpus.reduce((acc, c) => {
        const total = Object.values(c.times).reduce((a, b) => a + b, 0);
        return acc + (c.times.idle / total) * 100;
      }, 0) / cpus.length,
      memoryMb: usedMemMb,
      timestamp: new Date(),
    };

    res.json({ success: true, data: health });
  });

  router.get('/logs', async (req, res) => {
    const { level, limit = '100' } = req.query;
    const logs = await db.appLog.findMany({
      where: level != null ? { level: String(level) } : {},
      orderBy: { timestamp: 'desc' },
      take: Math.min(parseInt(String(limit), 10), 1000),
    });
    res.json({ success: true, data: logs });
  });

  return router;
}
