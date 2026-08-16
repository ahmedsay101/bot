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
});
