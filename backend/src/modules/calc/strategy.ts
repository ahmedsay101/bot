/**
 * Centralized strategy calculation service.
 * Used by Trader (Live + Simulation share the same formulas).
 * Percents are decimals: 0.10 = 10%, 0.03 = 3%.
 */
import Decimal from 'decimal.js';

/** Strategy knobs (decimal fractions). */
export interface StrategyPercents {
  /** Distance above previous reference for hedge entry (default 0.10). */
  hedgeDistance: string;
  /** Hedge SL below hedge entry (default 0.03). */
  hedgeSlPercent: string;
  /** Hedge TP above hedge entry (default 0.10). */
  hedgeTpPercent: string;
  /** Short TP below short entry (default 0.10). */
  shortTpPercent: string;
}

export interface HedgePricePlan {
  /** Previous reference used for entry (short entry or prior hedge TP). */
  previousReference: string;
  entry: Decimal;
  stopLoss: Decimal;
  takeProfit: Decimal;
}

/** Short take profit: P × (1 − shortTpPercent). */
export function calcShortTakeProfit(entryPrice: string | Decimal, shortTpPercent: string): Decimal {
  return new Decimal(entryPrice).mul(new Decimal(1).minus(shortTpPercent));
}

/** Hedge / next entry: ref × (1 + hedgeDistance). */
export function calcHedgeEntry(previousReference: string | Decimal, hedgeDistance: string): Decimal {
  return new Decimal(previousReference).mul(new Decimal(1).plus(hedgeDistance));
}

/** Hedge stop loss: entry × (1 − hedgeSlPercent). */
export function calcHedgeStopLoss(hedgeEntry: string | Decimal, hedgeSlPercent: string): Decimal {
  return new Decimal(hedgeEntry).mul(new Decimal(1).minus(hedgeSlPercent));
}

/** Hedge take profit: entry × (1 + hedgeTpPercent). */
export function calcHedgeTakeProfit(hedgeEntry: string | Decimal, hedgeTpPercent: string): Decimal {
  return new Decimal(hedgeEntry).mul(new Decimal(1).plus(hedgeTpPercent));
}

/** Next hedge entry from previous hedge TP fill. */
export function calcNextHedgeEntry(previousHedgeTp: string | Decimal, hedgeDistance: string): Decimal {
  return calcHedgeEntry(previousHedgeTp, hedgeDistance);
}

/**
 * Build raw (unrounded) hedge prices from a previous reference level.
 * Caller applies Binance tick rounding via adjustPrice.
 */
export function planHedgeFromReference(
  previousReference: string | Decimal,
  percents: Pick<StrategyPercents, 'hedgeDistance' | 'hedgeSlPercent' | 'hedgeTpPercent'>,
): HedgePricePlan {
  const entry = calcHedgeEntry(previousReference, percents.hedgeDistance);
  return {
    previousReference: new Decimal(previousReference).toFixed(),
    entry,
    stopLoss: calcHedgeStopLoss(entry, percents.hedgeSlPercent),
    takeProfit: calcHedgeTakeProfit(entry, percents.hedgeTpPercent),
  };
}

/** Alias kept for older call sites / tests. */
export const calcShortTp = calcShortTakeProfit;
export const calcHedgeTp = calcHedgeTakeProfit;
