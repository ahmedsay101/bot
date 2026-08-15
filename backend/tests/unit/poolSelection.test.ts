import {
  selectReplacementSymbols,
  calcBlockUntil,
  isBlockActive,
} from '../../src/modules/trader-manager/poolSelection';

describe('poolSelection — maxTraders is slot count not rank cutoff', () => {
  const isValid = (s: string) => s.endsWith('USDT') && !s.includes('UP');

  it('scans beyond maxTraders when top ranks are blocked', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['ETHUSDT']),
      blockedSymbols: new Set(['BTCUSDT', 'SOLUSDT']),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['XRPUSDT', 'DOGEUSDT']);
  });

  it('never exceeds maxTraders', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(),
      blockedSymbols: new Set(),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(selected.length).toBe(3);
  });

  it('skips duplicates in ranking', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'BTCUSDT', 'ETHUSDT'],
      maxTraders: 2,
      occupiedSymbols: new Set(),
      blockedSymbols: new Set(),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('supports multiple simultaneous blocks', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['SOLUSDT']),
      blockedSymbols: new Set(['BTCUSDT', 'ETHUSDT']),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['XRPUSDT', 'DOGEUSDT']);
  });

  it('returns empty when no eligible symbols', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['BTCUSDT', 'ETHUSDT']),
      blockedSymbols: new Set(),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual([]);
  });

  it('skips invalid / leveraged-style symbols', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUPUSDT', 'ETHUSDT', 'SOLUSDT'],
      maxTraders: 2,
      occupiedSymbols: new Set(),
      blockedSymbols: new Set(),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['ETHUSDT', 'SOLUSDT']);
  });

  it('expired block allows re-entry (caller removes from blocked set)', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT'],
      maxTraders: 1,
      occupiedSymbols: new Set(),
      blockedSymbols: new Set(), // expired → not in set
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['BTCUSDT']);
  });
});

describe('symbol block duration', () => {
  it('blockedUntil = blockedAt + duration hours', () => {
    const at = new Date('2026-08-16T01:00:00.000Z');
    const until = calcBlockUntil(at, 3);
    expect(until.toISOString()).toBe('2026-08-16T04:00:00.000Z');
  });

  it('isBlockActive is true before until, false at/after', () => {
    const until = new Date('2026-08-16T04:00:00.000Z');
    expect(isBlockActive(until, new Date('2026-08-16T03:59:59.000Z'))).toBe(true);
    expect(isBlockActive(until, new Date('2026-08-16T04:00:00.000Z'))).toBe(false);
    expect(isBlockActive(until, new Date('2026-08-16T04:00:01.000Z'))).toBe(false);
  });
});

describe('consecutive SL counter rules', () => {
  function apply(reason: 'TP' | 'SL', streak: number, limit: number): { streak: number; destroy: boolean } {
    let next = streak;
    if (reason === 'TP') next = 0;
    else next += 1;
    return { streak: next, destroy: next >= limit };
  }

  it('destroys at limit = 3', () => {
    let s = 0;
    s = apply('SL', s, 3).streak;
    expect(s).toBe(1);
    s = apply('SL', s, 3).streak;
    expect(s).toBe(2);
    const hit = apply('SL', s, 3);
    expect(hit.streak).toBe(3);
    expect(hit.destroy).toBe(true);
  });

  it('TP resets streak', () => {
    let s = 0;
    s = apply('SL', s, 3).streak;
    s = apply('SL', s, 3).streak;
    s = apply('TP', s, 3).streak;
    expect(s).toBe(0);
    const again = apply('SL', s, 3);
    expect(again.streak).toBe(1);
    expect(again.destroy).toBe(false);
  });

  it('configurable limit = 5', () => {
    let s = 0;
    for (let i = 0; i < 4; i++) s = apply('SL', s, 5).streak;
    expect(apply('SL', s, 5).destroy).toBe(true);
  });
});
