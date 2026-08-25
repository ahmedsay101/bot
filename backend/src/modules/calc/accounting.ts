import Decimal from 'decimal.js';
import { TESTING_BASE_EQUITY } from './allocation';
import { calcTotalMaintenanceMargin } from './maintenanceMargin';

/**
 * Single source of truth for account math (Decimal.js only).
 *
 * GLOBAL:
 *   Balance     = wallet cash after realized trades (fees already netted in)
 *   Realized    = cumulative closed-trade PnL (NET of fees)
 *   Unrealized  = mark-to-market on OPEN positions only (gross Δprice × qty)
 *   Equity      = Balance + Unrealized   (do NOT add realized again)
 *   Fees        = cumulative commissions (informational; already inside Realized/Balance)
 *   Net PnL     = Realized + Unrealized
 *
 * TRADER:
 *   Initial allocation  = frozen slice at spawn
 *   Realized            = net of fees (entry booked at fill; exit booked at TP)
 *   Current capital     = initial + Σ(net closes)   [entry fee reduces realized immediately,
 *                         capital catches up on close via net = gross − entry − exit]
 *   Equity              = currentCapital + unrealized
 *   Used margin         = Σ open position margins (EMPTY levels reserve 0)
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

/** Fallback when only usedMargin is known (prefer calcTotalMaintenanceMargin). */
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

export interface TraderAccountingReconciliation {
  initialCapital: string;
  realizedNetPnl: string;
  unrealizedPnl: string;
  totalFees: string;
  actualCurrentCapital: string;
  actualEquity: string;
  expectedCurrentCapital: string;
  expectedEquity: string;
  capitalDiff: string;
  equityDiff: string;
  ok: boolean;
}

/**
 * Trader identity (after all positions settled for the fee model):
 *   expectedCurrentCapital ≈ initial + realizedNet
 *   expectedEquity = expectedCurrentCapital + unrealized
 *
 * While positions are open, realized already includes −entryFees but currentCapital
 * only moves by full net at close — so capitalDiff may equal open entry fees.
 * Pass `openEntryFees` to account for that (optional).
 */
export function reconcileTraderAccounting(params: {
  initialCapital: Decimal | string;
  realizedNetPnl: Decimal | string;
  unrealizedPnl: Decimal | string;
  totalFees: Decimal | string;
  actualCurrentCapital: Decimal | string;
  actualEquity?: Decimal | string;
  /** Sum of entry fees on still-open positions (already in realized, not yet in capital). */
  openEntryFees?: Decimal | string;
  tolerance?: Decimal | string;
}): TraderAccountingReconciliation {
  const tol = new Decimal(params.tolerance ?? '0.0001');
  const initial = new Decimal(params.initialCapital);
  const realized = new Decimal(params.realizedNetPnl);
  const unrealized = new Decimal(params.unrealizedPnl);
  const openFees = new Decimal(params.openEntryFees ?? '0');
  // capital lags realized by open entry fees under Grid/NearPrice model
  const expectedCapital = initial.plus(realized).plus(openFees);
  const expectedEquity = expectedCapital.plus(unrealized);
  const actualCapital = new Decimal(params.actualCurrentCapital);
  const actualEquity = params.actualEquity != null
    ? new Decimal(params.actualEquity)
    : actualCapital.plus(unrealized);
  const capitalDiff = actualCapital.minus(expectedCapital);
  const equityDiff = actualEquity.minus(expectedEquity);
  return {
    initialCapital: initial.toFixed(8),
    realizedNetPnl: realized.toFixed(8),
    unrealizedPnl: unrealized.toFixed(8),
    totalFees: new Decimal(params.totalFees).toFixed(8),
    actualCurrentCapital: actualCapital.toFixed(8),
    actualEquity: actualEquity.toFixed(8),
    expectedCurrentCapital: expectedCapital.toFixed(8),
    expectedEquity: expectedEquity.toFixed(8),
    capitalDiff: capitalDiff.toFixed(8),
    equityDiff: equityDiff.toFixed(8),
    ok: capitalDiff.abs().lte(tol) && equityDiff.abs().lte(tol),
  };
}

export interface GlobalAccountingReconciliation {
  initialBalance: string;
  realizedNetPnl: string;
  totalFees: string;
  unrealizedPnl: string;
  actualBalance: string;
  actualEquity: string;
  expectedBalance: string;
  expectedEquity: string;
  balanceDiff: string;
  equityDiff: string;
  ok: boolean;
}

/** Global: balance = initial + netRealized; equity = balance + unrealized. */
export function reconcileGlobalAccounting(params: {
  initialBalance: Decimal | string;
  realizedNetPnl: Decimal | string;
  totalFees: Decimal | string;
  unrealizedPnl: Decimal | string;
  actualBalance: Decimal | string;
  actualEquity: Decimal | string;
  tolerance?: Decimal | string;
}): GlobalAccountingReconciliation {
  const tol = new Decimal(params.tolerance ?? '0.0001');
  const initial = new Decimal(params.initialBalance);
  const realized = new Decimal(params.realizedNetPnl);
  const unrealized = new Decimal(params.unrealizedPnl);
  const expectedBalance = initial.plus(realized);
  const expectedEquity = expectedBalance.plus(unrealized);
  const actualBalance = new Decimal(params.actualBalance);
  const actualEquity = new Decimal(params.actualEquity);
  const balanceDiff = actualBalance.minus(expectedBalance);
  const equityDiff = actualEquity.minus(expectedEquity);
  return {
    initialBalance: initial.toFixed(8),
    realizedNetPnl: realized.toFixed(8),
    totalFees: new Decimal(params.totalFees).toFixed(8),
    unrealizedPnl: unrealized.toFixed(8),
    actualBalance: actualBalance.toFixed(8),
    actualEquity: actualEquity.toFixed(8),
    expectedBalance: expectedBalance.toFixed(8),
    expectedEquity: expectedEquity.toFixed(8),
    balanceDiff: balanceDiff.toFixed(8),
    equityDiff: equityDiff.toFixed(8),
    ok: balanceDiff.abs().lte(tol) && equityDiff.abs().lte(tol),
  };
}
