/**
 * Candidate scan ranking + eligibility (full top-gainer list already analyzed).
 */
import {
  isEligibleForTraderCreation,
  rankStrongCandidates,
  summarizeScan,
} from '../../src/modules/trader-manager/candidateScan';
import type { TrendDetectionView } from '../../src/modules/trend';

function view(partial: Partial<TrendDetectionView> & { symbol: string }): TrendDetectionView {
  const now = Date.now();
  return {
    direction: 'BULLISH',
    confirmed: false,
    strength: 'NONE',
    status: 'NO_TREND',
    score: 0,
    maxScore: 7,
    requiredScore: 6,
    confidence: 0,
    signals: {
      emaAlignment: false,
      priceVsEma: false,
      adxStrong: false,
      diConfirms: false,
      momentumOk: false,
      volumeConfirmed: false,
    },
    multiSignals: {
      emaPrimary: false,
      emaConfirmation: false,
      adx: false,
      di: false,
      momentum: false,
      volume: false,
      priceStructure: false,
    },
    timeframe: '15m',
    confirmationTimeframe: '1h',
    confirmationConfirmed: false,
    adx: 0,
    evaluatedAt: now,
    timestamp: now,
    ...partial,
  };
}

describe('candidateScan', () => {
  const occupied = new Set<string>();
  const maxAgeMs = 300_000;

  it('rejects weak/moderate/unconfirmed', () => {
    expect(isEligibleForTraderCreation(
      view({ symbol: 'A', strength: 'WEAK', confirmed: false, score: 4 }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(false);
    expect(isEligibleForTraderCreation(
      view({ symbol: 'B', strength: 'MODERATE', confirmed: false, score: 5 }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(false);
  });

  it('accepts only STRONG confirmed fresh non-occupied', () => {
    expect(isEligibleForTraderCreation(
      view({
        symbol: 'ETHUSDT',
        strength: 'STRONG',
        confirmed: true,
        status: 'STRONG_CONFIRMED',
        score: 7,
        confidence: 1,
        adx: 35,
      }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(true);

    expect(isEligibleForTraderCreation(
      view({
        symbol: 'ETHUSDT',
        strength: 'STRONG',
        confirmed: true,
        status: 'STRONG_CONFIRMED',
        score: 7,
      }),
      { occupiedSymbols: new Set(['ETHUSDT']), maxAgeMs },
    )).toBe(false);
  });

  it('rejects stale results', () => {
    expect(isEligibleForTraderCreation(
      view({
        symbol: 'X',
        strength: 'STRONG',
        confirmed: true,
        status: 'STRONG_CONFIRMED',
        score: 7,
        evaluatedAt: Date.now() - 400_000,
      }),
      { occupiedSymbols: occupied, maxAgeMs: 300_000 },
    )).toBe(false);
  });

  it('ranks by score then ADX over 24h gain', () => {
    const results = [
      view({
        symbol: 'BTCUSDT',
        strength: 'STRONG',
        confirmed: true,
        status: 'STRONG_CONFIRMED',
        score: 6,
        confidence: 6 / 7,
        adx: 32,
      }),
      view({
        symbol: 'ETHUSDT',
        strength: 'STRONG',
        confirmed: true,
        status: 'STRONG_CONFIRMED',
        score: 7,
        confidence: 1,
        adx: 38,
      }),
      view({
        symbol: 'SOLUSDT',
        strength: 'MODERATE',
        confirmed: false,
        score: 5,
      }),
    ];
    const gain = new Map([
      ['BTCUSDT', { priceChangePercent: '15', gainRank: 1 }],
      ['ETHUSDT', { priceChangePercent: '10', gainRank: 2 }],
      ['SOLUSDT', { priceChangePercent: '12', gainRank: 3 }],
    ]);
    const ranked = rankStrongCandidates(results, gain, {
      occupiedSymbols: occupied,
      maxAgeMs,
    });
    expect(ranked.map((r) => r.symbol)).toEqual(['ETHUSDT', 'BTCUSDT']);
    // ETH ranks first despite lower 24h gain
    expect(ranked[0]!.gainRank).toBe(2);
  });

  it('summarizeScan counts strengths', () => {
    const s = summarizeScan([
      view({ symbol: 'a', strength: 'STRONG', status: 'STRONG_CONFIRMED' }),
      view({ symbol: 'b', strength: 'MODERATE', status: 'MODERATE' }),
      view({ symbol: 'c', strength: 'WEAK', status: 'WEAK' }),
      view({ symbol: 'd', strength: 'NONE', status: 'ERROR' }),
      view({ symbol: 'e', strength: 'NONE', status: 'NO_TREND' }),
    ]);
    expect(s).toEqual({
      analyzed: 5,
      strong: 1,
      moderate: 1,
      weak: 1,
      none: 1,
      errors: 1,
    });
  });

  it('availableSlots caps creates conceptually', () => {
    const strong = ['A', 'B', 'C', 'D'].map((symbol) =>
      view({
        symbol,
        strength: 'STRONG',
        confirmed: true,
        status: 'STRONG_CONFIRMED',
        score: 7,
        confidence: 1,
        adx: 40,
      }),
    );
    const gain = new Map(strong.map((r, i) => [r.symbol, { priceChangePercent: '1', gainRank: i + 1 }]));
    const ranked = rankStrongCandidates(strong, gain, { occupiedSymbols: new Set(['A']), maxAgeMs });
    const availableSlots = 2;
    const toCreate = ranked.slice(0, availableSlots);
    expect(toCreate).toHaveLength(2);
    expect(toCreate.map((c) => c.symbol)).not.toContain('A');
  });
});
