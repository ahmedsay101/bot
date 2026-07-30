/**
 * Standalone BullMQ worker process.
 * Runs alongside the main server to process background jobs.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { logger } from './modules/logger';
import { BinanceClient } from './modules/binance/client';
import { StatisticsService } from './modules/statistics/StatisticsService';
import { startWorkers, stopWorkers } from './modules/jobs/workers';
import { scheduleRecurringJobs, closeQueues } from './modules/jobs/queues';

const log = logger.child({ context: 'Worker' });

async function bootstrap(): Promise<void> {
  log.info('Starting BullMQ worker process...');

  const db = new PrismaClient();
  await db.$connect();

  const binanceClient = new BinanceClient();
  await binanceClient.initialize();

  const mode = (process.env.TRADING_MODE ?? 'SIMULATION') as 'LIVE' | 'SIMULATION';
  const statisticsService = new StatisticsService(db, binanceClient, mode);

  // Dummy trader manager for worker (workers only need stats + health)
  const dummyManager = {
    getActiveTraderCount: () => 0,
    getTraderSummary: () => [],
    getTopGainers: () => [],
    getTotalRealizedPnl: () => '0',
    getTotalUnrealizedPnl: () => '0',
    on: () => dummyManager,
    off: () => dummyManager,
    emit: () => false,
  };

  await scheduleRecurringJobs();
  startWorkers(statisticsService, dummyManager as unknown as import('./modules/trader-manager/TraderManager').TraderManager);

  log.info('Worker process started');

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`Worker received ${signal}`);
    await stopWorkers();
    await closeQueues();
    await db.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('Worker unhandled rejection', { reason: String(reason) });
  });
}

bootstrap().catch((err: Error) => {
  logger.error('Worker fatal error', { error: err.message });
  process.exit(1);
});
