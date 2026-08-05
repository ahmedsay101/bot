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
  const precision = Math.max(0, pricePrecision);
  return new Decimal(price).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP).toFixed(precision);
}

/** Decimal places implied by a tick/step size (e.g. 0.00001 → 5). */
export function countDecimals(value: string): number {
  const normalized = new Decimal(value).toFixed();
  const idx = normalized.indexOf('.');
  if (idx === -1) return 0;
  return normalized.length - idx - 1;
}

/**
 * Format a quantity to the symbol's quantity precision.
 */
export function formatQuantity(qty: Decimal | string, quantityPrecision: number): string {
  return new Decimal(qty).toDecimalPlaces(quantityPrecision, Decimal.ROUND_DOWN).toFixed(quantityPrecision);
}

/**
 * Validate a price satisfies Binance filters and return the adjusted value.
 * Uses max(pricePrecision, tickSize decimals) so micro-priced alts never truncate to 0.
 */
export function adjustPrice(price: Decimal | string, symbolInfo: SymbolInfo): string {
  const input = new Decimal(price);
  if (!input.isFinite() || input.lte(0)) {
    throw new Error(`Invalid price ${price} for ${symbolInfo.symbol}`);
  }
  const tick = new Decimal(symbolInfo.tickSize);
  if (!tick.isFinite() || tick.lte(0)) {
    throw new Error(`Invalid tickSize ${symbolInfo.tickSize} for ${symbolInfo.symbol}`);
  }

  const adjusted = roundToTickSize(input, symbolInfo.tickSize);
  if (adjusted.lte(0)) {
    throw new Error(
      `Price ${price} rounds to zero with tickSize=${symbolInfo.tickSize} for ${symbolInfo.symbol}`,
    );
  }

  // Binance pricePrecision can be smaller than tick decimals on some alts — never truncate below tick
  const precision = Math.max(symbolInfo.pricePrecision, countDecimals(symbolInfo.tickSize));
  const formatted = formatPrice(adjusted, precision);
  if (new Decimal(formatted).lte(0)) {
    throw new Error(
      `Formatted price is zero for ${symbolInfo.symbol} (raw=${price}, tick=${symbolInfo.tickSize}, precision=${precision})`,
    );
  }
  return formatted;
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

// Strategy price formulas — single source in modules/calc/strategy.ts
export {
  calcShortTakeProfit as calcShortTp,
  calcHedgeEntry,
  calcHedgeTakeProfit as calcHedgeTp,
  calcHedgeStopLoss,
  calcNextHedgeEntry,
  planHedgeFromReference,
} from '../calc/strategy';

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
