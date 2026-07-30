import { createContextLogger } from '../logger';

const log = createContextLogger('Retry');

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  retryOn?: (err: unknown) => boolean;
}

/**
 * Execute an async function with exponential backoff retry.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const backoff = opts.backoffFactor ?? 2;
  const maxDelay = opts.maxDelayMs ?? 30000;
  const shouldRetry = opts.retryOn ?? (() => true);

  let delay = opts.delayMs;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.maxAttempts || !shouldRetry(err)) {
        throw err;
      }

      log.warn(`Attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${delay}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });

      await sleep(delay);
      delay = Math.min(delay * backoff, maxDelay);
    }
  }

  throw new Error('withRetry: exhausted — should never reach here');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple circuit breaker.
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureAt = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private readonly log = createContextLogger('CircuitBreaker');

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 60000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.log.info(`Circuit breaker ${this.name} → HALF_OPEN`);
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state !== 'CLOSED') {
      this.log.info(`Circuit breaker ${this.name} → CLOSED`);
      this.state = 'CLOSED';
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.log.warn(`Circuit breaker ${this.name} → OPEN after ${this.failures} failures`);
      this.state = 'OPEN';
    }
  }

  isOpen(): boolean {
    return this.state === 'OPEN';
  }

  reset(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }
}

/**
 * Deduplication guard — prevents processing the same event ID twice.
 */
export class DeduplicationGuard {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60000) {
    this.ttlMs = ttlMs;
  }

  isDuplicate(id: string): boolean {
    this.evict();
    if (this.seen.has(id)) return true;
    this.seen.set(id, Date.now());
    return false;
  }

  private evict(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }
}
