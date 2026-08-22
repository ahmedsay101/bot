/**
 * Candidate scan ranking + eligibility (selective TRADE gate).
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
    maxScore: 100,
    requiredScore: 85,
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
    decision: 'NO_TRADE',
    regime: 'UNCERTAIN',
    confidenceScore: 0,
    rejectionReasons: [],
    efficiencyRatio: 0,
    relativeVolume: 0,
    reversalRisk: 100,
    distanceToResistanceATR: 0,
    distanceToSupportATR: 0,
    mtfAligned: 0,
    mtfTotal: 4,
    plusDi: 0,
    minusDi: 0,
    atrPercent: 0,
    trendAge: 'UNKNOWN',
    reasons: [],
    ...partial,
  };
}

function tradeView(partial: Partial<TrendDetectionView> & { symbol: string }): TrendDetectionView {
  return view({
    decision: 'TRADE',
    regime: 'STRONG_TREND',
    confirmed: true,
    strength: 'STRONG',
    status: 'STRONG_CONFIRMED',
    confidenceScore: 90,
    score: 90,
    requiredScore: 85,
    confidence: 0.9,
    adx: 35,
    efficiencyRatio: 0.7,
    mtfAligned: 4,
    rejectionReasons: [],
    ...partial,
  });
}

describe('candidateScan', () => {
  const occupied = new Set<string>();
  const maxAgeMs = 300_000;

  it('rejects weak/moderate/unconfirmed / NO_TRADE', () => {
    expect(isEligibleForTraderCreation(
      view({ symbol: 'A', strength: 'WEAK', confirmed: false, score: 40 }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(false);
    expect(isEligibleForTraderCreation(
      view({
        symbol: 'B',
        strength: 'STRONG',
        confirmed: true,
        decision: 'NO_TRADE',
        regime: 'STRONG_TREND',
        confidenceScore: 90,
      }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(false);
  });

  it('accepts only TRADE + STRONG_TREND + confidence', () => {
    expect(isEligibleForTraderCreation(
      tradeView({ symbol: 'ETHUSDT' }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(true);

    expect(isEligibleForTraderCreation(
      tradeView({ symbol: 'ETHUSDT' }),
      { occupiedSymbols: new Set(['ETHUSDT']), maxAgeMs },
    )).toBe(false);

    expect(isEligibleForTraderCreation(
      tradeView({ symbol: 'X', confidenceScore: 80, requiredScore: 85 }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(false);
  });

  it('rejects stale results', () => {
    expect(isEligibleForTraderCreation(
      tradeView({
        symbol: 'X',
        evaluatedAt: Date.now() - 400_000,
      }),
      { occupiedSymbols: occupied, maxAgeMs: 300_000 },
    )).toBe(false);
  });

  it('ranks by confidence then efficiency over 24h gain', () => {
    const results = [
      tradeView({
        symbol: 'BTCUSDT',
        confidenceScore: 86,
        efficiencyRatio: 0.5,
        adx: 32,
      }),
      tradeView({
        symbol: 'ETHUSDT',
        confidenceScore: 93,
        efficiencyRatio: 0.8,
        adx: 38,
      }),
      view({
        symbol: 'SOLUSDT',
        strength: 'MODERATE',
        confirmed: false,
        score: 50,
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
    expect(ranked[0]!.gainRank).toBe(2);
  });

  it('summarizeScan counts strengths', () => {
    const s = summarizeScan([
      tradeView({ symbol: 'a' }),
      view({ symbol: 'b', strength: 'MODERATE', status: 'MODERATE' }),
      view({ symbol: 'c', strength: 'WEAK', status: 'WEAK' }),
      view({ symbol: 'd', strength: 'NONE', status: 'ERROR' }),
      view({ symbol: 'e', strength: 'NONE', status: 'NO_TREND' }),
    ]);
    expect(s).toEqual({
      analyzed: 5,
      strong: 1,
      trade: 1,
      moderate: 1,
      weak: 1,
      none: 1,
      errors: 1,
    });
  });

  it('availableSlots caps creates — never fills with weak signals', () => {
    const strong = ['A', 'B', 'C', 'D'].map((symbol) => tradeView({ symbol }));
    const gain = new Map(strong.map((r, i) => [r.symbol, { priceChangePercent: '1', gainRank: i + 1 }]));
    const ranked = rankStrongCandidates(strong, gain, { occupiedSymbols: new Set(['A']), maxAgeMs });
    const availableSlots = 2;
    const toCreate = ranked.slice(0, availableSlots);
    expect(toCreate).toHaveLength(2);
    expect(toCreate.map((c) => c.symbol)).not.toContain('A');
  });
});
