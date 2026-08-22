/**
 * Candidate scan ranking + eligibility (balanced TRADE gate).
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
    requiredScore: 78,
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
    confidenceScore: 82,
    score: 82,
    requiredScore: 78,
    confidence: 0.82,
    adx: 28,
    efficiencyRatio: 0.55,
    mtfAligned: 3,
    rejectionReasons: [],
    ...partial,
  });
}

describe('candidateScan', () => {
  const occupied = new Set<string>();
  const maxAgeMs = 300_000;

  it('rejects NO_TRADE / below confidence', () => {
    expect(isEligibleForTraderCreation(
      view({ symbol: 'A', strength: 'WEAK', confirmed: false }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(false);
    expect(isEligibleForTraderCreation(
      tradeView({ symbol: 'X', confidenceScore: 70, requiredScore: 78 }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(false);
  });

  it('accepts STRONG_TREND and DEVELOPING_STRONG_TREND', () => {
    expect(isEligibleForTraderCreation(
      tradeView({ symbol: 'ETHUSDT' }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(true);
    expect(isEligibleForTraderCreation(
      tradeView({ symbol: 'SOLUSDT', regime: 'DEVELOPING_STRONG_TREND', confidenceScore: 80 }),
      { occupiedSymbols: occupied, maxAgeMs },
    )).toBe(true);
  });

  it('ranks developing below equal-confidence strong', () => {
    const results = [
      tradeView({
        symbol: 'DEV',
        regime: 'DEVELOPING_STRONG_TREND',
        confidenceScore: 85,
        efficiencyRatio: 0.5,
      }),
      tradeView({
        symbol: 'STR',
        regime: 'STRONG_TREND',
        confidenceScore: 85,
        efficiencyRatio: 0.5,
      }),
    ];
    const gain = new Map([
      ['DEV', { priceChangePercent: '10', gainRank: 1 }],
      ['STR', { priceChangePercent: '8', gainRank: 2 }],
    ]);
    const ranked = rankStrongCandidates(results, gain, { occupiedSymbols: occupied, maxAgeMs });
    expect(ranked[0]!.symbol).toBe('STR');
  });

  it('summarizeScan includes developing + eligible', () => {
    const s = summarizeScan([
      tradeView({ symbol: 'a', regime: 'STRONG_TREND' }),
      tradeView({ symbol: 'b', regime: 'DEVELOPING_STRONG_TREND' }),
      view({ symbol: 'c', strength: 'MODERATE', status: 'MODERATE', regime: 'WEAK_TREND' }),
      view({ symbol: 'd', strength: 'NONE', status: 'ERROR' }),
      view({ symbol: 'e', strength: 'NONE', status: 'NO_TREND' }),
    ]);
    expect(s.trade).toBe(2);
    expect(s.eligible).toBe(2);
    expect(s.strong).toBe(1);
    expect(s.developingStrong).toBe(1);
    expect(s.errors).toBe(1);
  });
});
