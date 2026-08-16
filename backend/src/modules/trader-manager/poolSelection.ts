/**
 * Pure trader-pool selection — maxTraders is slot count, NOT a ranking cutoff.
 * Scan ranked top-gainers from highest to lowest; skip occupied/invalid.
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
  const desired = Math.max(0, params.maxTraders);
  const occupied = params.occupiedSymbols.size;
  const slotsNeeded = Math.max(0, desired - occupied);
  if (slotsNeeded <= 0) return [];

  const selected: string[] = [];
  const seen = new Set<string>();
  const isValid = params.isValidSymbol ?? (() => true);
  const skip = params.skipSymbols ?? new Set<string>();
  const blocked = params.blockedSymbols ?? new Set<string>();

  for (const symbol of params.rankedSymbols) {
    if (selected.length >= slotsNeeded) break;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    if (params.occupiedSymbols.has(symbol)) continue;
    if (blocked.has(symbol)) continue;
    if (skip.has(symbol)) continue;
    if (!isValid(symbol)) continue;
    selected.push(symbol);
  }

  return selected;
}
