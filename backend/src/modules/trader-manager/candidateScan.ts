/**
 * Pure candidate ranking after full top-gainer trend scan.
 * Trend quality > 24h gain rank. Never manufacture signals to fill slots.
 */
import type { TrendDetectionView } from '../trend/TrendDetector';
import { isTradeableRegime } from '../trend/trendEngine';

export interface RankedCandidate extends TrendDetectionView {
  priceChangePercent: string;
  gainRank: number;
}

export function isEligibleForTraderCreation(
  view: TrendDetectionView,
  opts: {
    occupiedSymbols: ReadonlySet<string>;
    pendingSymbols?: ReadonlySet<string>;
    maxAgeMs: number;
    now?: number;
  },
): boolean {
  const now = opts.now ?? Date.now();
  if (view.decision !== 'TRADE') return false;
  if (!view.confirmed) return false;
  if (view.strength !== 'STRONG') return false;
  if (!isTradeableRegime(view.regime)) return false;
  if (view.status === 'ERROR') return false;
  if (view.direction === 'NONE') return false;
  if (view.confidenceScore < view.requiredScore) return false;
  if (opts.occupiedSymbols.has(view.symbol)) return false;
  if (opts.pendingSymbols?.has(view.symbol)) return false;
  if (now - view.evaluatedAt > opts.maxAgeMs) return false;
  return true;
}

/**
 * Rank TRADE candidates: confidence → efficiency → MTF → ADX → gain rank.
 */
export function rankStrongCandidates(
  results: TrendDetectionView[],
  gainBySymbol: Map<string, { priceChangePercent: string; gainRank: number }>,
  opts: {
    occupiedSymbols: ReadonlySet<string>;
    pendingSymbols?: ReadonlySet<string>;
    maxAgeMs: number;
    now?: number;
  },
): RankedCandidate[] {
  const eligible: RankedCandidate[] = [];
  for (const r of results) {
    if (!isEligibleForTraderCreation(r, opts)) continue;
    const g = gainBySymbol.get(r.symbol);
    eligible.push({
      ...r,
      priceChangePercent: g?.priceChangePercent ?? '0',
      gainRank: g?.gainRank ?? 9999,
    });
  }

  eligible.sort((a, b) => {
    const regimeRank = (r: string) => (r === 'STRONG_TREND' ? 2 : r === 'DEVELOPING_STRONG_TREND' ? 1 : 0);
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    if (regimeRank(b.regime) !== regimeRank(a.regime)) return regimeRank(b.regime) - regimeRank(a.regime);
    if (b.efficiencyRatio !== a.efficiencyRatio) return b.efficiencyRatio - a.efficiencyRatio;
    if (b.mtfAligned !== a.mtfAligned) return b.mtfAligned - a.mtfAligned;
    if (b.adx !== a.adx) return b.adx - a.adx;
    return a.gainRank - b.gainRank;
  });

  return eligible;
}

export function summarizeScan(results: TrendDetectionView[]): {
  analyzed: number;
  strong: number;
  developingStrong: number;
  trade: number;
  moderate: number;
  weak: number;
  none: number;
  errors: number;
  noTrade: number;
  eligible: number;
  rejectionHistogram: Record<string, number>;
} {
  let strong = 0;
  let developingStrong = 0;
  let trade = 0;
  let moderate = 0;
  let weak = 0;
  let none = 0;
  let errors = 0;
  let noTrade = 0;
  let eligible = 0;
  const rejectionHistogram: Record<string, number> = {};
  for (const r of results) {
    if (r.status === 'ERROR') errors++;
    if (r.decision === 'TRADE') {
      trade++;
      eligible++;
    } else {
      noTrade++;
      const codes = r.rejectionCodes?.length
        ? r.rejectionCodes
        : (r.rejectionReasons?.length ? ['OTHER'] : ['OTHER']);
      for (const c of codes) {
        rejectionHistogram[c] = (rejectionHistogram[c] ?? 0) + 1;
      }
    }
    if (r.regime === 'STRONG_TREND') strong++;
    else if (r.regime === 'DEVELOPING_STRONG_TREND') developingStrong++;
    else if (r.strength === 'MODERATE' || r.regime === 'WEAK_TREND') moderate++;
    else if (r.strength === 'WEAK') weak++;
    else if (r.decision !== 'TRADE' && r.status !== 'ERROR') none++;
  }
  return {
    analyzed: results.length,
    strong,
    developingStrong,
    trade,
    moderate,
    weak,
    none,
    errors,
    noTrade,
    eligible,
    rejectionHistogram,
  };
}

/** Top N candidates by confidence for production diagnostics (eligible or not). */
export function topCandidatesByConfidence(
  results: TrendDetectionView[],
  limit = 10,
): Array<{
  symbol: string;
  confidence: number;
  direction: string;
  regime: string;
  decision: string;
  eligible: boolean;
  reason: string;
  corePassed: number;
  adx: number;
  h4Bias: string;
  h1Bias: string;
}> {
  return [...results]
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, limit)
    .map((r) => ({
      symbol: r.symbol,
      confidence: r.confidenceScore,
      direction: r.direction,
      regime: r.regime,
      decision: r.decision,
      eligible: r.decision === 'TRADE' && r.confirmed,
      reason: (r.rejectionCodes?.[0] ?? r.rejectionReasons?.[0] ?? r.reasons?.[0] ?? (r.decision === 'TRADE' ? 'OK' : 'NO_TRADE')),
      corePassed: r.coreSignalsPassed ?? 0,
      adx: r.adx,
      h4Bias: r.h4Bias ?? '?',
      h1Bias: r.h1Bias ?? '?',
    }));
}
