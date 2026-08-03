import Decimal from 'decimal.js';
import { TESTING_BASE_EQUITY } from './allocation';
import { calcTotalMaintenanceMargin } from './maintenanceMargin';

/**
 * Single source of truth for account math (Decimal.js only).
 *
 * Balance     = wallet cash after realized trades (and fees)
 * Realized    = cumulative closed-trade PnL (net of fees)
 * Unrealized  = mark-to-market on open positions
 * Equity      = Balance + Unrealized
 * UsedMargin  = sum(notional / leverage) for open legs
 * Available   = Equity - UsedMargin
 * Maintenance = Binance-style bracket (notional × MMR − cum) per leg
 */
export interface AccountSnapshot {
  balance: string;
  equity: string;
  realizedPnl: string;
  unrealizedPnl: string;
  dailyPnl: string;
  totalFees: string;
  openPositionValue: string;
  usedMargin: string;
  availableMargin: string;
  maintenanceMargin: string;
}

export function calcEquity(balance: Decimal | string, unrealizedPnl: Decimal | string): Decimal {
  return new Decimal(balance).plus(unrealizedPnl);
}

export function calcUsedMargin(openNotionals: Array<Decimal | string>, leverage: number): Decimal {
  const lev = Math.max(1, leverage);
  let used = new Decimal(0);
  for (const n of openNotionals) used = used.plus(new Decimal(n).div(lev));
  return used;
}

export function calcAvailableMargin(equity: Decimal | string, usedMargin: Decimal | string): Decimal {
  return Decimal.max(new Decimal(0), new Decimal(equity).minus(usedMargin));
}

/**
 * @deprecated Prefer calcTotalMaintenanceMargin (bracket formula).
 * Kept for callers that only have usedMargin — approximates as usedMargin/leverage.
 */
export function calcMaintenanceMargin(usedMargin: Decimal | string, leverage: number): Decimal {
  const lev = Math.max(1, leverage);
  return new Decimal(usedMargin).div(lev);
}

export function calcOpenPositionValue(openNotionals: Array<Decimal | string>): Decimal {
  let total = new Decimal(0);
  for (const n of openNotionals) total = total.plus(n);
  return total;
}

export function buildAccountSnapshot(params: {
  balance: Decimal | string;
  realizedPnl: Decimal | string;
  unrealizedPnl: Decimal | string;
  dailyPnl: Decimal | string;
  totalFees: Decimal | string;
  openNotionals: Array<Decimal | string>;
  leverage: number;
}): AccountSnapshot {
  const balance = new Decimal(params.balance);
  const unrealized = new Decimal(params.unrealizedPnl);
  const equity = calcEquity(balance, unrealized);
  const openPositionValue = calcOpenPositionValue(params.openNotionals);
  const usedMargin = calcUsedMargin(params.openNotionals, params.leverage);
  const availableMargin = calcAvailableMargin(equity, usedMargin);
  const maintenanceMargin = calcTotalMaintenanceMargin(params.openNotionals);

  return {
    balance: balance.toFixed(8),
    equity: equity.toFixed(8),
    realizedPnl: new Decimal(params.realizedPnl).toFixed(8),
    unrealizedPnl: unrealized.toFixed(8),
    dailyPnl: new Decimal(params.dailyPnl).toFixed(8),
    totalFees: new Decimal(params.totalFees).toFixed(8),
    openPositionValue: openPositionValue.toFixed(8),
    usedMargin: usedMargin.toFixed(8),
    availableMargin: availableMargin.toFixed(8),
    maintenanceMargin: maintenanceMargin.toFixed(8),
  };
}

export function testingStartingBalance(): Decimal {
  return new Decimal(TESTING_BASE_EQUITY);
}

/**
 * Apply a closed-trade result to wallet balance.
 * netPnl should already be the economic PnL; fee is deducted from balance separately
 * if not already netted into netPnl. Convention: netPnl is GROSS price PnL, fee subtracted here.
 */
export function applyRealizedTrade(
  balance: Decimal | string,
  realizedPnl: Decimal | string,
  totalFees: Decimal | string,
  grossPnl: Decimal | string,
  fee: Decimal | string,
): { balance: Decimal; realizedPnl: Decimal; totalFees: Decimal; netPnl: Decimal } {
  const feeD = new Decimal(fee);
  const gross = new Decimal(grossPnl);
  const net = gross.minus(feeD);
  return {
    balance: new Decimal(balance).plus(net),
    realizedPnl: new Decimal(realizedPnl).plus(net),
    totalFees: new Decimal(totalFees).plus(feeD),
    netPnl: net,
  };
}
