import Decimal from 'decimal.js';
import type { SymbolInfo } from '../../types';

export function countDecimals(value: string): number {
  const s = value.includes('e') || value.includes('E')
    ? new Decimal(value).toFixed()
    : value;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function roundToTickSize(price: string | Decimal, tickSize: string): Decimal {
  const p = new Decimal(price);
  const tick = new Decimal(tickSize);
  if (tick.isZero()) return p;
  return p.div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(tick);
}

export function roundToStepSize(qty: string | Decimal, stepSize: string): Decimal {
  const q = new Decimal(qty);
  const step = new Decimal(stepSize);
  if (step.isZero()) return q;
  return q.div(step).toDecimalPlaces(0, Decimal.ROUND_DOWN).mul(step);
}

/**
 * Round price to exchange tick. Uses max(pricePrecision, tick decimals)
 * so micro-priced alts never truncate to zero.
 */
export function adjustPrice(price: string | Decimal, info: SymbolInfo): string {
  const p = new Decimal(price);
  if (!p.isFinite() || p.lte(0)) {
    throw new Error(`Invalid price: ${String(price)}`);
  }
  const tickDecimals = countDecimals(info.tickSize);
  const decimals = Math.max(info.pricePrecision, tickDecimals);
  const rounded = roundToTickSize(p, info.tickSize);
  const out = rounded.toFixed(decimals);
  if (new Decimal(out).lte(0)) {
    throw new Error(`Price rounded to zero for ${info.symbol}: ${String(price)}`);
  }
  return out;
}

export function adjustQuantity(qty: string | Decimal, info: SymbolInfo): string {
  const rounded = roundToStepSize(qty, info.stepSize);
  const min = new Decimal(info.minQty);
  if (rounded.lt(min)) {
    throw new Error(`Quantity ${rounded.toFixed()} below minQty ${info.minQty} for ${info.symbol}`);
  }
  return rounded.toFixed(info.quantityPrecision);
}

export function validateNotional(price: string, quantity: string, info: SymbolInfo): void {
  const notional = new Decimal(price).mul(quantity);
  const min = new Decimal(info.minNotional);
  if (notional.lt(min)) {
    throw new Error(
      `Notional ${notional.toFixed()} below minNotional ${info.minNotional} for ${info.symbol}`,
    );
  }
}

// Strategy V2 — re-export from calc/strategy
export {
  calcTakeProfit,
  calcStopLoss,
  planPositionPrices,
  oppositeSide,
  nextSideAfterClose,
  marketSideForPosition,
  calcPositionUnrealizedPnl,
  calcPositionRoi,
} from '../calc/strategy';

export {
  calcStepAmount,
  calcStepUnit,
  buildStepLadder,
  nextStepAfterClose,
  clampStep,
  calcStepNotional,
  simulateStepSequence,
} from '../calc/capitalSteps';

export function calcShortUnrealizedPnl(entryPrice: string, markPrice: string, quantity: string): Decimal {
  return new Decimal(entryPrice).minus(markPrice).mul(quantity);
}

export function calcLongUnrealizedPnl(entryPrice: string, markPrice: string, quantity: string): Decimal {
  return new Decimal(markPrice).minus(entryPrice).mul(quantity);
}

export function calcFee(price: string, quantity: string, feeRate: string): Decimal {
  return new Decimal(price).mul(quantity).mul(feeRate);
}

export { Decimal };
