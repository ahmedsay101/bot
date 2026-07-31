import Decimal from 'decimal.js';
import type { SymbolInfo } from '../../types';
import { adjustQuantity, validateNotional } from '../utils/precision';

/** Fixed testing-mode base equity (USDT). Realized PnL is added on top. */
export const TESTING_BASE_EQUITY = '200';

export interface AllocationBreakdown {
  totalEquity: Decimal;
  traderEquity: Decimal;
  /** Capital allocated to one leg (main short OR hedge). */
  positionAllocation: Decimal;
  /** Notional for one leg = allocation × leverage. */
  positionNotional: Decimal;
  maxTraders: number;
  leverage: number;
}

/**
 * Equity → per-trader → half for main / half for hedge → notional.
 * traderEquity = totalEquity / maxTraders
 * positionAllocation = traderEquity / 2
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
  const positionAllocation = traderEquity.div(2);
  const positionNotional = positionAllocation.mul(lev);

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
