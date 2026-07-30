import { DeduplicationGuard, CircuitBreaker, withRetry } from '../../../src/modules/utils/retry';

describe('DeduplicationGuard', () => {
  it('returns false for new events', () => {
    const guard = new DeduplicationGuard(1000);
    expect(guard.isDuplicate('event-1')).toBe(false);
  });

  it('returns true for duplicate events', () => {
    const guard = new DeduplicationGuard(1000);
    guard.isDuplicate('event-1');
    expect(guard.isDuplicate('event-1')).toBe(true);
  });

  it('allows different events', () => {
    const guard = new DeduplicationGuard(1000);
    guard.isDuplicate('event-1');
    expect(guard.isDuplicate('event-2')).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker('test', 3, 1000);
    expect(cb.isOpen()).toBe(false);
  });

  it('opens after threshold failures', async () => {
    const cb = new CircuitBreaker('test', 3, 1000);
    const fail = () => Promise.reject(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(fail);
      } catch {
        // expected
      }
    }
    expect(cb.isOpen()).toBe(true);
  });

  it('throws when open', async () => {
    const cb = new CircuitBreaker('test', 1, 1000);
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch {
      // expected
    }
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow('OPEN');
  });

  it('resets manually', async () => {
    const cb = new CircuitBreaker('test', 1, 1000);
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch {
      // expected
    }
    cb.reset();
    expect(cb.isOpen()).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('not yet');
        return 'success';
      },
      { maxAttempts: 5, delayMs: 10 },
    );
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws after max attempts', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('always fails');
        },
        { maxAttempts: 3, delayMs: 10 },
      ),
    ).rejects.toThrow('always fails');
    expect(attempts).toBe(3);
  });

  it('does not retry if retryOn returns false', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('permanent');
        },
        { maxAttempts: 5, delayMs: 10, retryOn: () => false },
      ),
    ).rejects.toThrow('permanent');
    expect(attempts).toBe(1);
  });
});
