import { Worker } from 'bullmq';
import { redisConnection } from './queues';
import { createContextLogger } from '../logger';
import type { StatisticsService } from '../statistics/StatisticsService';
import type { TraderManager } from '../trader-manager/TraderManager';

const log = createContextLogger('Workers');

let statisticsWorker: Worker | null = null;
let symbolRefreshWorker: Worker | null = null;
let healthCheckWorker: Worker | null = null;

export function startWorkers(statisticsService: StatisticsService, traderManager: TraderManager): void {
  statisticsWorker = new Worker(
    'statistics',
    async (_job) => {
      await statisticsService.refreshStatistics();
    },
    { connection: redisConnection, concurrency: 1 },
  );

  symbolRefreshWorker = new Worker(
    'symbol-refresh',
    async (_job) => {
      log.debug('Symbol refresh job triggered');
      // TraderManager handles its own refresh via interval;
      // this job is for external triggers
    },
    { connection: redisConnection, concurrency: 1 },
  );

  healthCheckWorker = new Worker(
    'health-check',
    async (_job) => {
      const count = traderManager.getActiveTraderCount();
      log.debug(`Health check: ${count} active traders`);
    },
    { connection: redisConnection, concurrency: 1 },
  );

  for (const worker of [statisticsWorker, symbolRefreshWorker, healthCheckWorker]) {
    worker.on('failed', (job, err) => {
      log.error(`Job failed: ${job?.name ?? 'unknown'}`, { error: err.message });
    });
    worker.on('error', (err) => {
      log.error('Worker error', { error: err.message });
    });
  }

  log.info('BullMQ workers started');
}

export async function stopWorkers(): Promise<void> {
  await statisticsWorker?.close();
  await symbolRefreshWorker?.close();
  await healthCheckWorker?.close();
  log.info('Workers stopped');
}
