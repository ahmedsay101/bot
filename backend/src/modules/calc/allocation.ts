import Decimal from 'decimal.js';
import type { SymbolInfo } from '../../types';
import { adjustQuantity, validateNotional } from '../utils/precision';
import { calcPositionNotional } from './leverage';

/** Fixed testing-mode base equity (USDT). Realized PnL is added on top. */
export const TESTING_BASE_EQUITY = '2000';

export interface AllocationBreakdown {
  totalEquity: Decimal;
  traderEquity: Decimal;
  /** Margin allocated to the position (capital, not exposure). */
  positionAllocation: Decimal;
  /** Exposure = positionAllocation × leverage. */
  positionNotional: Decimal;
  maxTraders: number;
  leverage: number;
}

/**
 * Equity → per-trader margin → notional (leverage applied once).
 * traderEquity = totalEquity / maxTraders
 * positionAllocation = traderEquity  (margin)
 * positionNotional = positionAllocation × leverage
 */
export function calcAllocation(
  totalEquity: Decimal | string,
  maxTraders: number,
  leverage: number,
): AllocationBreakdown {
  const equity = new Decimal(totalEquity);
  const traders = Math.max(1, maxTraders);
  const lev = Math.max(1, leverage);
  const traderEquity = equity.div(traders);
  const positionAllocation = traderEquity;
  const positionNotional = calcPositionNotional(positionAllocation, lev);

  return {
    totalEquity: equity,
    traderEquity,
    positionAllocation,
    positionNotional,
    maxTraders: traders,
    leverage: lev,
  };
}

/**
 * Convert notional USDT to exchange-adjusted quantity at a given price.
 */
export function calcQuantityFromNotional(
  notional: Decimal | string,
  price: string,
  symbolInfo: SymbolInfo,
): string {
  const px = new Decimal(price);
  if (px.isZero() || px.isNaN() || px.isNeg()) {
    throw new Error(`Cannot size position: invalid price '${price}' for ${symbolInfo.symbol}`);
  }
  const rawQty = new Decimal(notional).div(px);
  const qty = adjustQuantity(rawQty, symbolInfo);
  validateNotional(price, qty, symbolInfo);
  return qty;
}

/**
 * Testing equity = base 200 + realized PnL.
 */
export function calcTestingEquity(realizedPnl: Decimal | string): Decimal {
  return new Decimal(TESTING_BASE_EQUITY).plus(realizedPnl);
}

/**
 * Total PnL displayed on dashboard (realized + unrealized).
 */
export function calcTotalPnl(realized: Decimal | string, unrealized: Decimal | string): Decimal {
  return new Decimal(realized).plus(unrealized);
}
