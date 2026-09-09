import {
  explainTopGainerSelection,
  meetsMin24hChange,
  selectReplacementSymbols,
} from '../../src/modules/trader-manager/poolSelection';

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

  it('need 1 slot with active=3 MAX=4 — continues past blocked/duplicate to 4th eligible', () => {
    const { selected, decisions, slotsNeeded } = explainTopGainerSelection({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT'],
      maxTraders: 4,
      occupiedSymbols: new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
      blockedSymbols: new Set(['XRPUSDT']),
      isValidSymbol: isValid,
    });
    expect(slotsNeeded).toBe(1);
    expect(selected).toEqual(['DOGEUSDT']);
    expect(decisions.find((d) => d.symbol === 'XRPUSDT')).toEqual({
      symbol: 'XRPUSDT',
      action: 'skip',
      reason: 'BLOCKED',
    });
    expect(decisions.find((d) => d.symbol === 'DOGEUSDT')).toEqual({
      symbol: 'DOGEUSDT',
      action: 'select',
    });
  });

  it('example: skips active/blocked then fills remaining slots from deeper list', () => {
    // occupied 1, max 4 → need 3; skip ETH blocked → SOL, XRP, DOGE
    expect(selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT'],
      maxTraders: 4,
      occupiedSymbols: new Set(['BTCUSDT']),
      blockedSymbols: new Set(['ETHUSDT']),
      isValidSymbol: isValid,
    })).toEqual(['SOLUSDT', 'XRPUSDT', 'DOGEUSDT']);
  });

  it('empty pool fills four when none occupied', () => {
    expect(selectReplacementSymbols({
      rankedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
      maxTraders: 4,
      occupiedSymbols: new Set(),
      blockedSymbols: new Set(['ETHUSDT']),
      isValidSymbol: isValid,
    })).toEqual(['BTCUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']);
  });

  it('meetsMin24hChange is inclusive of the exact minimum', () => {
    expect(meetsMin24hChange('50', '50')).toBe(true);
    expect(meetsMin24hChange(50, 50)).toBe(true);
    expect(meetsMin24hChange('49.99', '50')).toBe(false);
    expect(meetsMin24hChange('12.3', '50')).toBe(false);
    expect(meetsMin24hChange(undefined, '50')).toBe(false);
    expect(meetsMin24hChange('abc', '50')).toBe(false);
  });

  it('skips symbols whose 24h change is below the minimum', () => {
    const { selected, decisions } = explainTopGainerSelection({
      rankedSymbols: ['HOTUSDT', 'WARMUSDT', 'COLDUSDT', 'OKUSDT'],
      maxTraders: 2,
      occupiedSymbols: new Set(),
      isValidSymbol: isValid,
      min24hChangePercent: '50',
      priceChangeBySymbol: new Map([
        ['HOTUSDT', '80'],
        ['WARMUSDT', '49.9'],
        ['COLDUSDT', '10'],
        ['OKUSDT', '50'],
      ]),
    });
    expect(selected).toEqual(['HOTUSDT', 'OKUSDT']);
    expect(decisions.find((d) => d.symbol === 'WARMUSDT')).toEqual({
      symbol: 'WARMUSDT',
      action: 'skip',
      reason: 'BELOW_MIN_24H_CHANGE',
    });
  });
});
