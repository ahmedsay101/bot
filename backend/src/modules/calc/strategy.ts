/**
 * Strategy V2 — single-position reversal.
 * Percents are decimals: 0.10 = 10%.
 * Shared by Live and Simulation (execution differs only).
 */
import Decimal from 'decimal.js';

export type TradeSide = 'LONG' | 'SHORT';

export interface ReversalPercents {
  takeProfitPercent: string;
  stopLossPercent: string;
}

export interface PositionPricePlan {
  side: TradeSide;
  entry: Decimal;
  takeProfit: Decimal;
  stopLoss: Decimal;
}

/** Opposite side for SL reversal. */
export function oppositeSide(side: TradeSide): TradeSide {
  return side === 'SHORT' ? 'LONG' : 'SHORT';
}

/** Same side after TP. */
export function sameSide(side: TradeSide): TradeSide {
  return side;
}

/**
 * Take profit from entry.
 * SHORT: entry × (1 − tp%)  |  LONG: entry × (1 + tp%)
 */
export function calcTakeProfit(
  entryPrice: string | Decimal,
  side: TradeSide,
  takeProfitPercent: string,
): Decimal {
  const entry = new Decimal(entryPrice);
  const pct = new Decimal(takeProfitPercent);
  return side === 'SHORT'
    ? entry.mul(new Decimal(1).minus(pct))
    : entry.mul(new Decimal(1).plus(pct));
}

/**
 * Stop loss from entry.
 * SHORT: entry × (1 + sl%)  |  LONG: entry × (1 − sl%)
 */
export function calcStopLoss(
  entryPrice: string | Decimal,
  side: TradeSide,
  stopLossPercent: string,
): Decimal {
  const entry = new Decimal(entryPrice);
  const pct = new Decimal(stopLossPercent);
  return side === 'SHORT'
    ? entry.mul(new Decimal(1).plus(pct))
    : entry.mul(new Decimal(1).minus(pct));
}

/** Build TP/SL around a known fill price. */
export function planPositionPrices(
  entryPrice: string | Decimal,
  side: TradeSide,
  percents: ReversalPercents,
): PositionPricePlan {
  return {
    side,
    entry: new Decimal(entryPrice),
    takeProfit: calcTakeProfit(entryPrice, side, percents.takeProfitPercent),
    stopLoss: calcStopLoss(entryPrice, side, percents.stopLossPercent),
  };
}

/** Market order side to open a position. */
export function marketSideForPosition(side: TradeSide): 'BUY' | 'SELL' {
  return side === 'LONG' ? 'BUY' : 'SELL';
}

/** Unrealized PnL for open position. */
export function calcPositionUnrealizedPnl(
  side: TradeSide,
  entryPrice: string,
  markPrice: string,
  quantity: string,
): Decimal {
  const entry = new Decimal(entryPrice);
  const mark = new Decimal(markPrice);
  const qty = new Decimal(quantity);
  return side === 'SHORT' ? entry.minus(mark).mul(qty) : mark.minus(entry).mul(qty);
}

/** ROI as fraction of notional (entry × qty). */
export function calcPositionRoi(
  side: TradeSide,
  entryPrice: string,
  markPrice: string,
  quantity: string,
): Decimal {
  const notional = new Decimal(entryPrice).mul(quantity);
  if (notional.isZero()) return new Decimal(0);
  return calcPositionUnrealizedPnl(side, entryPrice, markPrice, quantity).div(notional).mul(100);
}

/** Next side after a close. Default: TP→same, SL→opposite. */
export function nextSideAfterClose(
  current: TradeSide,
  reason: 'TP' | 'SL',
  opts?: { switchPositionOnTakeProfit?: boolean },
): TradeSide {
  const switchOnTp = opts?.switchPositionOnTakeProfit === true;
  if (switchOnTp) {
    return reason === 'TP' ? oppositeSide(current) : sameSide(current);
  }
  return reason === 'TP' ? sameSide(current) : oppositeSide(current);
}
