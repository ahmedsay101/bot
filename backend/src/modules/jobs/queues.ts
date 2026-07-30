import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../../config';
import { createContextLogger } from '../logger';

const log = createContextLogger('Jobs');

export const redisConnection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
});

redisConnection.on('error', (err) => {
  log.error('Redis connection error', { error: err.message });
});

// Queue definitions
export const statisticsQueue = new Queue('statistics', { connection: redisConnection });
export const symbolRefreshQueue = new Queue('symbol-refresh', { connection: redisConnection });
export const healthCheckQueue = new Queue('health-check', { connection: redisConnection });
export const logPersistQueue = new Queue('log-persist', { connection: redisConnection });

export type JobName = 'refresh-statistics' | 'refresh-symbols' | 'health-check' | 'persist-log';

export interface StatisticsJobData {
  type: 'refresh-statistics';
}

export interface SymbolRefreshJobData {
  type: 'refresh-symbols';
}

export interface HealthCheckJobData {
  type: 'health-check';
}

export interface LogPersistJobData {
  type: 'persist-log';
  level: string;
  message: string;
  context?: string;
  meta?: Record<string, unknown>;
}

/**
 * Schedule recurring jobs.
 */
export async function scheduleRecurringJobs(): Promise<void> {
  // Statistics refresh every 30 seconds
  await statisticsQueue.add(
    'refresh-statistics',
    { type: 'refresh-statistics' } satisfies StatisticsJobData,
    { repeat: { every: 30000 }, removeOnComplete: 10, removeOnFail: 5 },
  );

  // Symbol refresh every minute
  await symbolRefreshQueue.add(
    'refresh-symbols',
    { type: 'refresh-symbols' } satisfies SymbolRefreshJobData,
    { repeat: { every: config.trading.refreshInterval }, removeOnComplete: 5, removeOnFail: 5 },
  );

  // Health check every 10 seconds
  await healthCheckQueue.add(
    'health-check',
    { type: 'health-check' } satisfies HealthCheckJobData,
    { repeat: { every: 10000 }, removeOnComplete: 5, removeOnFail: 5 },
  );

  log.info('Recurring jobs scheduled');
}

export async function closeQueues(): Promise<void> {
  await statisticsQueue.close();
  await symbolRefreshQueue.close();
  await healthCheckQueue.close();
  await logPersistQueue.close();
  await redisConnection.quit();
  log.info('Job queues closed');
}
