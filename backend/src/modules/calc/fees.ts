/**
 * Binance Futures fee accounting — shared by Live and Simulation.
 *
 * Fee = executedNotional × rate  (official USDT-M formula)
 * Prefer actual Binance commission when present; otherwise estimate with configured rates.
 * Regular VIP0 defaults: maker 0.02%, taker 0.05% (docs.binance.com Futures fee schedule).
 */
import Decimal from 'decimal.js';

export interface FeeRates {
  /** Limit / maker side (decimal, e.g. 0.0002 = 0.02%). */
  makerFeeRate: string;
  /** Market / taker side (decimal, e.g. 0.0005 = 0.05%). */
  takerFeeRate: string;
}

export type FeeLiquidity = 'MAKER' | 'TAKER';

export interface ExecutionFeeInput {
  price: string | Decimal;
  quantity: string | Decimal;
  /** Actual commission from Binance / sim fill — preferred when present. */
  actualFee?: string | Decimal | null;
  rates: FeeRates;
  liquidity?: FeeLiquidity;
}

export interface PositionFeeBreakdown {
  grossPnl: Decimal;
  entryFee: Decimal;
  exitFee: Decimal;
  totalFees: Decimal;
  netPnl: Decimal;
}

/** Resolve rate for liquidity (MARKET / STOP_MARKET / immediate fills → TAKER). */
export function feeRateForLiquidity(rates: FeeRates, liquidity: FeeLiquidity = 'TAKER'): string {
  return liquidity === 'MAKER' ? rates.makerFeeRate : rates.takerFeeRate;
}

/**
 * Estimate fee from notional × rate.
 * Fee = qty × price × rate
 */
export function estimateExecutionFee(
  price: string | Decimal,
  quantity: string | Decimal,
  feeRate: string,
): Decimal {
  return new Decimal(price).mul(quantity).mul(feeRate).abs();
}

/**
 * Prefer actual Binance commission; fall back to estimate.
 * Never returns negative (commission amounts are absolute costs).
 */
export function resolveExecutionFee(input: ExecutionFeeInput): Decimal {
  if (input.actualFee != null && input.actualFee !== '') {
    try {
      const d = new Decimal(input.actualFee);
      if (d.isFinite()) return d.abs();
    } catch {
      // fall through to estimate
    }
  }
  const rate = feeRateForLiquidity(input.rates, input.liquidity ?? 'TAKER');
  return estimateExecutionFee(input.price, input.quantity, rate);
}

/** Gross price PnL (before fees). */
export function calcGrossPnl(
  side: 'LONG' | 'SHORT',
  entryPrice: string | Decimal,
  exitPrice: string | Decimal,
  quantity: string | Decimal,
): Decimal {
  const entry = new Decimal(entryPrice);
  const exit = new Decimal(exitPrice);
  const qty = new Decimal(quantity);
  return side === 'SHORT' ? entry.minus(exit).mul(qty) : exit.minus(entry).mul(qty);
}

/** Net = gross − entryFee − exitFee. */
export function calcNetPnl(
  grossPnl: Decimal | string,
  entryFee: Decimal | string,
  exitFee: Decimal | string,
): Decimal {
  return new Decimal(grossPnl).minus(entryFee).minus(exitFee);
}

export function buildPositionFeeBreakdown(
  side: 'LONG' | 'SHORT',
  entryPrice: string | Decimal,
  exitPrice: string | Decimal,
  quantity: string | Decimal,
  entryFee: Decimal | string,
  exitFee: Decimal | string,
): PositionFeeBreakdown {
  const grossPnl = calcGrossPnl(side, entryPrice, exitPrice, quantity);
  const entry = new Decimal(entryFee).abs();
  const exit = new Decimal(exitFee).abs();
  const totalFees = entry.plus(exit);
  return {
    grossPnl,
    entryFee: entry,
    exitFee: exit,
    totalFees,
    netPnl: calcNetPnl(grossPnl, entry, exit),
  };
}

/**
 * Estimated remaining exit fee for an open position (mark × qty × taker).
 * Used for net unrealized display only — does not book to balance.
 */
export function estimateOpenExitFee(
  markPrice: string | Decimal,
  quantity: string | Decimal,
  rates: FeeRates,
): Decimal {
  return estimateExecutionFee(markPrice, quantity, rates.takerFeeRate);
}

/** Legacy single-rate helper → FeeRates (taker = rate, maker = rate unless overridden). */
export function feeRatesFromConfig(cfg: {
  feeRate?: string;
  takerFeeRate?: string;
  makerFeeRate?: string;
}): FeeRates {
  const taker = cfg.takerFeeRate ?? cfg.feeRate ?? '0.0005';
  const maker = cfg.makerFeeRate ?? '0.0002';
  return { makerFeeRate: maker, takerFeeRate: taker };
}
