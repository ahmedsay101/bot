import { env } from '../../core/env.js';
import type { MarketDataService } from '../marketData.service.js';
import type { IExecutionService } from './execution.interface.js';
import { TestExecutionService } from './testExecution.service.js';
import { LiveExecutionService } from './liveExecution.service.js';

export function createExecutionService(market: MarketDataService): IExecutionService {
  if (env.MODE === 'live') return new LiveExecutionService();
  return new TestExecutionService(market);
}

export type { IExecutionService } from './execution.interface.js';
export { TestExecutionService, LiveExecutionService };
export { newClientOrderId } from './testExecution.service.js';
