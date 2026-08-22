/**
 * Pure candidate ranking after full top-gainer trend scan.
 * Trend quality > 24h gain rank. Never manufacture signals to fill slots.
 */
import type { TrendDetectionView } from '../trend/TrendDetector';

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
  if (view.regime !== 'STRONG_TREND') return false;
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
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
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
  trade: number;
  moderate: number;
  weak: number;
  none: number;
  errors: number;
} {
  let strong = 0;
  let trade = 0;
  let moderate = 0;
  let weak = 0;
  let none = 0;
  let errors = 0;
  for (const r of results) {
    if (r.status === 'ERROR') errors++;
    else if (r.decision === 'TRADE') {
      trade++;
      strong++;
    } else if (r.strength === 'STRONG') strong++;
    else if (r.strength === 'MODERATE') moderate++;
    else if (r.strength === 'WEAK') weak++;
    else none++;
  }
  return { analyzed: results.length, strong, trade, moderate, weak, none, errors };
}
