import { selectReplacementSymbols } from '../../src/modules/trader-manager/poolSelection';

describe('poolSelection — maxTraders is slot count not rank cutoff', () => {
  const isValid = (s: string) => s.endsWith('USDT') && !s.includes('UP');

  it('scans beyond maxTraders when top ranks are skipped', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['ETHUSDT']),
      skipSymbols: new Set(['BTCUSDT', 'SOLUSDT']),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['XRPUSDT', 'DOGEUSDT']);
  });

  it('never exceeds maxTraders', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(),
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
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('returns empty when no eligible symbols', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['BTCUSDT', 'ETHUSDT']),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual([]);
  });

  it('skips invalid / leveraged-style symbols', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['BTCUPUSDT', 'ETHUSDT', 'SOLUSDT'],
      maxTraders: 2,
      occupiedSymbols: new Set(),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['ETHUSDT', 'SOLUSDT']);
  });

  it('MAX_TRADERS=1 with one eligible → one symbol', () => {
    expect(selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT'],
      maxTraders: 1,
      occupiedSymbols: new Set(),
      isValidSymbol: isValid,
    })).toEqual(['BTCUSDT']);
  });

  it('MAX_TRADERS=3 with five eligible → three symbols', () => {
    expect(selectReplacementSymbols({
      rankedSymbols: ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(),
      isValidSymbol: isValid,
    })).toEqual(['AUSDT', 'BUSDT', 'CUSDT']);
  });

  it('MAX_TRADERS=3 with only two eligible → two symbols', () => {
    expect(selectReplacementSymbols({
      rankedSymbols: ['AUSDT', 'BUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(),
      isValidSymbol: isValid,
    })).toEqual(['AUSDT', 'BUSDT']);
  });

  it('blocked symbols are skipped (no trend filter)', () => {
    expect(selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['BTCUSDT']),
      blockedSymbols: new Set(['ETHUSDT']),
      isValidSymbol: isValid,
    })).toEqual(['SOLUSDT', 'XRPUSDT']);
  });

  it('already active symbols are skipped', () => {
    expect(selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['BTCUSDT', 'ETHUSDT']),
      isValidSymbol: isValid,
    })).toEqual(['SOLUSDT']);
  });

  it('no additional when already at MAX_TRADERS', () => {
    expect(selectReplacementSymbols({
      rankedSymbols: ['AUSDT', 'BUSDT', 'CUSDT'],
      maxTraders: 3,
      occupiedSymbols: new Set(['XUSDT', 'YUSDT', 'ZUSDT']),
      isValidSymbol: isValid,
    })).toEqual([]);
  });

  it('selection is gain-rank only — no trend confirmation', () => {
    const selected = selectReplacementSymbols({
      rankedSymbols: ['WEAKUSDT', 'NOTRENDUSDT', 'STRONGUSDT'],
      maxTraders: 2,
      occupiedSymbols: new Set(),
      isValidSymbol: isValid,
    });
    expect(selected).toEqual(['WEAKUSDT', 'NOTRENDUSDT']);
  });
});
