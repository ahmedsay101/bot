import Decimal from 'decimal.js';
import type { SymbolInfo } from '../../types';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/**
 * Round a price to the symbol's tick size.
 */
export function roundToTickSize(price: Decimal | string, tickSize: string): Decimal {
  const d = new Decimal(price);
  const tick = new Decimal(tickSize);
  return d.div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(tick);
}

/**
 * Round a quantity to the symbol's step size.
 */
export function roundToStepSize(qty: Decimal | string, stepSize: string): Decimal {
  const d = new Decimal(qty);
  const step = new Decimal(stepSize);
  return d.div(step).toDecimalPlaces(0, Decimal.ROUND_DOWN).mul(step);
}

/**
 * Format a price to the symbol's price precision.
 */
export function formatPrice(price: Decimal | string, pricePrecision: number): string {
  return new Decimal(price).toDecimalPlaces(pricePrecision, Decimal.ROUND_HALF_UP).toFixed(pricePrecision);
}

/**
 * Format a quantity to the symbol's quantity precision.
 */
export function formatQuantity(qty: Decimal | string, quantityPrecision: number): string {
  return new Decimal(qty).toDecimalPlaces(quantityPrecision, Decimal.ROUND_DOWN).toFixed(quantityPrecision);
}

/**
 * Validate a price satisfies Binance filters and return the adjusted value.
 */
export function adjustPrice(price: Decimal | string, symbolInfo: SymbolInfo): string {
  const adjusted = roundToTickSize(new Decimal(price), symbolInfo.tickSize);
  return formatPrice(adjusted, symbolInfo.pricePrecision);
}

/**
 * Validate and adjust a quantity; throws if below minimums.
 */
export function adjustQuantity(qty: Decimal | string, symbolInfo: SymbolInfo): string {
  const adjusted = roundToStepSize(new Decimal(qty), symbolInfo.stepSize);
  if (adjusted.lt(symbolInfo.minQty)) {
    throw new Error(
      `Quantity ${adjusted.toFixed()} is below minimum ${symbolInfo.minQty} for ${symbolInfo.symbol}`,
    );
  }
  return formatQuantity(adjusted, symbolInfo.quantityPrecision);
}

/**
 * Check that the notional value (price * qty) meets Binance minimum.
 */
export function validateNotional(price: string, quantity: string, symbolInfo: SymbolInfo): void {
  const notional = new Decimal(price).mul(quantity);
  if (notional.lt(symbolInfo.minNotional)) {
    throw new Error(
      `Notional ${notional.toFixed()} is below minimum ${symbolInfo.minNotional} for ${symbolInfo.symbol}`,
    );
  }
}

/**
 * Calculate the take profit price for a short position.
 * shortEntry * (1 - tpPercent)
 */
export function calcShortTp(entryPrice: string, tpPercent: string): Decimal {
  const entry = new Decimal(entryPrice);
  const tp = new Decimal(tpPercent);
  return entry.mul(new Decimal(1).minus(tp));
}

/**
 * Calculate the initial hedge entry price.
 * shortEntry * (1 + hedgeDistance)
 */
export function calcHedgeEntry(shortEntry: string, hedgeDistance: string): Decimal {
  const entry = new Decimal(shortEntry);
  return entry.mul(new Decimal(1).plus(hedgeDistance));
}

/**
 * Calculate the hedge take profit price.
 * hedgeEntry * (1 + tpPercent)
 */
export function calcHedgeTp(hedgeEntry: string, tpPercent: string): Decimal {
  const entry = new Decimal(hedgeEntry);
  return entry.mul(new Decimal(1).plus(tpPercent));
}

/**
 * Calculate the next hedge entry from a previous TP.
 * prevTp * (1 + hedgeDistance)
 */
export function calcNextHedgeEntry(prevTp: string, hedgeDistance: string): Decimal {
  return new Decimal(prevTp).mul(new Decimal(1).plus(hedgeDistance));
}

/**
 * Calculate unrealized PnL for a SHORT position.
 * (entryPrice - markPrice) * quantity
 */
export function calcShortUnrealizedPnl(entryPrice: string, markPrice: string, quantity: string): Decimal {
  return new Decimal(entryPrice).minus(markPrice).mul(quantity);
}

/**
 * Calculate unrealized PnL for a LONG position.
 * (markPrice - entryPrice) * quantity
 */
export function calcLongUnrealizedPnl(entryPrice: string, markPrice: string, quantity: string): Decimal {
  return new Decimal(markPrice).minus(entryPrice).mul(quantity);
}

/**
 * Calculate fee for a trade.
 * price * quantity * feeRate
 */
export function calcFee(price: string, quantity: string, feeRate: string): Decimal {
  return new Decimal(price).mul(quantity).mul(feeRate);
}

export { Decimal };
