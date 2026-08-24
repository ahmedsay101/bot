export type CandidateSkipReason =
  | 'ALREADY_ACTIVE'
  | 'BLOCKED'
  | 'PENDING_CREATE'
  | 'INVALID'
  | 'DUPLICATE_IN_LIST'
  | 'RECENT_CREATE_FAIL';

export type CandidateDecision =
  | { symbol: string; action: 'select' }
  | { symbol: string; action: 'skip'; reason: CandidateSkipReason };

/**
 * Pure trader-pool selection — maxTraders is slot count, NOT a ranking cutoff.
 * Scan ranked top-gainers from highest to lowest; skip occupied/invalid.
 * Continues past rejected candidates until slots are filled or the list ends.
 */
export function selectReplacementSymbols(params: {
  rankedSymbols: string[];
  maxTraders: number;
  /** Symbols that already occupy a trader slot (active / initializing / rotating). */
  occupiedSymbols: ReadonlySet<string>;
  /** Optional symbols to exclude (e.g. temporarily skipped). */
  blockedSymbols?: ReadonlySet<string>;
  /** Additional symbols to skip (e.g. being destroyed). */
  skipSymbols?: ReadonlySet<string>;
  isValidSymbol?: (symbol: string) => boolean;
}): string[] {
  return explainTopGainerSelection(params).selected;
}

/** Same scan as selectReplacementSymbols, with per-candidate skip/select decisions. */
export function explainTopGainerSelection(params: {
  rankedSymbols: string[];
  maxTraders: number;
  occupiedSymbols: ReadonlySet<string>;
  blockedSymbols?: ReadonlySet<string>;
  skipSymbols?: ReadonlySet<string>;
  isValidSymbol?: (symbol: string) => boolean;
}): { selected: string[]; decisions: CandidateDecision[]; slotsNeeded: number } {
  const desired = Math.max(0, params.maxTraders);
  const occupied = params.occupiedSymbols.size;
  const slotsNeeded = Math.max(0, desired - occupied);
  if (slotsNeeded <= 0) {
    return { selected: [], decisions: [], slotsNeeded: 0 };
  }

  const selected: string[] = [];
  const decisions: CandidateDecision[] = [];
  const seen = new Set<string>();
  const isValid = params.isValidSymbol ?? (() => true);
  const skip = params.skipSymbols ?? new Set<string>();
  const blocked = params.blockedSymbols ?? new Set<string>();

  for (const symbol of params.rankedSymbols) {
    if (selected.length >= slotsNeeded) break;
    if (seen.has(symbol)) {
      decisions.push({ symbol, action: 'skip', reason: 'DUPLICATE_IN_LIST' });
      continue;
    }
    seen.add(symbol);
    if (params.occupiedSymbols.has(symbol)) {
      decisions.push({ symbol, action: 'skip', reason: 'ALREADY_ACTIVE' });
      continue;
    }
    if (blocked.has(symbol)) {
      decisions.push({ symbol, action: 'skip', reason: 'BLOCKED' });
      continue;
    }
    if (skip.has(symbol)) {
      decisions.push({
        symbol,
        action: 'skip',
        reason: 'PENDING_CREATE',
      });
      continue;
    }
    if (!isValid(symbol)) {
      decisions.push({ symbol, action: 'skip', reason: 'INVALID' });
      continue;
    }
    decisions.push({ symbol, action: 'select' });
    selected.push(symbol);
  }

  return { selected, decisions, slotsNeeded };
}
