/**
 * Shared leverage / margin / notional helpers (Decimal.js).
 * Used by Testing + Live so exposure math stays identical.
 *
 * Rules:
 * - allocatedMargin = capital committed (cash margin)
 * - positionNotional = allocatedMargin × leverage  (applied exactly once)
 * - quantity = positionNotional / price (then exchange filters)
 * - gross PnL = quantity × priceMove  (= notional × % move)
 * - equity adds unrealized PnL, NEVER open notional as cash
 */
import Decimal from 'decimal.js';
import { createContextLogger } from '../logger';
import { calcPositionUnrealizedPnl } from './strategy';
import { calcGrossPnl, estimateExecutionFee, calcNetPnl } from './fees';

const log = createContextLogger('Leverage');

/** positionNotional = allocatedMargin × leverage (leverage applied once). */
export function calcPositionNotional(
  allocatedMargin: string | Decimal,
  leverage: number,
): Decimal {
  const lev = Math.max(1, leverage);
  return new Decimal(allocatedMargin).mul(lev);
}

/** Actual exposure from fill: entryPrice × quantity. */
export function calcActualNotional(
  entryPrice: string | Decimal,
  quantity: string | Decimal,
): Decimal {
  return new Decimal(entryPrice).mul(quantity).abs();
}

/** Margin implied by notional at given leverage. */
export function calcMarginFromNotional(
  notional: string | Decimal,
  leverage: number,
): Decimal {
  const lev = Math.max(1, leverage);
  return new Decimal(notional).div(lev);
}

/**
 * Gross PnL from notional × price move % (equivalent to qty × Δprice).
 * LONG:  notional × (exit − entry) / entry
 * SHORT: notional × (entry − exit) / entry
 */
export function calcGrossPnlFromNotional(
  side: 'LONG' | 'SHORT',
  entryPrice: string | Decimal,
  exitPrice: string | Decimal,
  positionNotional: string | Decimal,
): Decimal {
  const entry = new Decimal(entryPrice);
  if (entry.isZero()) return new Decimal(0);
  const move = side === 'SHORT'
    ? entry.minus(exitPrice).div(entry)
    : new Decimal(exitPrice).minus(entry).div(entry);
  return new Decimal(positionNotional).mul(move);
}

/** Same as calcPositionUnrealizedPnl — qty × Δprice (leverage already in qty). */
export function calcLeveragedUnrealizedPnl(
  side: 'LONG' | 'SHORT',
  entryPrice: string,
  markPrice: string,
  quantity: string,
): Decimal {
  return calcPositionUnrealizedPnl(side, entryPrice, markPrice, quantity);
}

export function calcLeveragedGrossPnl(
  side: 'LONG' | 'SHORT',
  entryPrice: string | Decimal,
  exitPrice: string | Decimal,
  quantity: string | Decimal,
): Decimal {
  return calcGrossPnl(side, entryPrice, exitPrice, quantity);
}

export function calcFeeOnNotional(
  price: string | Decimal,
  quantity: string | Decimal,
  feeRate: string,
): Decimal {
  return estimateExecutionFee(price, quantity, feeRate);
}

export function calcLeveragedNetPnl(
  grossPnl: Decimal | string,
  entryFee: Decimal | string,
  exitFee: Decimal | string,
): Decimal {
  return calcNetPnl(grossPnl, entryFee, exitFee);
}

export interface LeverageReconcileInput {
  traderId?: string;
  symbol?: string;
  positionId?: string;
  allocatedMargin: string | Decimal;
  leverage: number;
  actualNotional: string | Decimal;
  quantity?: string;
  entryPrice?: string;
  /** Relative tolerance (default 2% for exchange rounding). */
  tolerancePct?: number;
}

/**
 * Verify actualNotional ≈ allocatedMargin × leverage.
 * Logs a warning on mismatch — never throws (rounding / fill slip is normal).
 */
export function reconcilePositionNotional(input: LeverageReconcileInput): {
  expectedNotional: Decimal;
  actualNotional: Decimal;
  ok: boolean;
  ratio: Decimal;
} {
  const expected = calcPositionNotional(input.allocatedMargin, input.leverage);
  const actual = new Decimal(input.actualNotional).abs();
  const tol = new Decimal(input.tolerancePct ?? 2).div(100);
  let ratio = new Decimal(1);
  if (expected.gt(0)) {
    ratio = actual.div(expected);
  } else if (actual.gt(0)) {
    ratio = new Decimal(Infinity);
  }
  const ok = expected.isZero()
    ? actual.isZero()
    : ratio.gte(new Decimal(1).minus(tol)) && ratio.lte(new Decimal(1).plus(tol));

  if (!ok) {
    log.warn('LEVERAGE_NOTIONAL_MISMATCH', {
      traderId: input.traderId,
      symbol: input.symbol,
      positionId: input.positionId,
      allocatedMargin: String(input.allocatedMargin),
      leverage: input.leverage,
      expectedNotional: expected.toFixed(8),
      actualNotional: actual.toFixed(8),
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      ratio: ratio.isFinite() ? ratio.toFixed(6) : 'inf',
    });
  }

  return { expectedNotional: expected, actualNotional: actual, ok, ratio };
}
