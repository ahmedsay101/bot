import Decimal from 'decimal.js';

/**
 * USDT-M Futures style notional brackets (simplified global table).
 * Matches Binance structure: higher notional → higher maintenance margin rate.
 * Values are representative of major USDⓈ-M perpetuals (e.g. BTC/ETH class).
 *
 * notionalFloor: bracket applies when notional >= floor (USDT)
 * mmr: maintenance margin rate
 * cum: quick calculation amount (cum) for that bracket
 */
export interface MarginBracket {
  notionalFloor: string;
  mmr: string;
  cum: string;
}

/** Standard Binance-like brackets for generic USDT-M perpetuals. */
export const USDT_MARGIN_BRACKETS: MarginBracket[] = [
  { notionalFloor: '0', mmr: '0.004', cum: '0' },
  { notionalFloor: '50000', mmr: '0.005', cum: '50' },
  { notionalFloor: '250000', mmr: '0.01', cum: '1300' },
  { notionalFloor: '1000000', mmr: '0.02', cum: '11300' },
  { notionalFloor: '5000000', mmr: '0.05', cum: '61300' },
  { notionalFloor: '20000000', mmr: '0.1', cum: '261300' },
  { notionalFloor: '50000000', mmr: '0.125', cum: '761300' },
  { notionalFloor: '100000000', mmr: '0.15', cum: '2011300' },
  { notionalFloor: '200000000', mmr: '0.25', cum: '7011300' },
  { notionalFloor: '300000000', mmr: '0.5', cum: '22011300' },
];

/**
 * Maintenance Margin = notional × MMR − cum
 * (Binance formula for isolated/cross position maintenance)
 */
export function calcMaintenanceMarginFromNotional(
  notional: Decimal | string,
  brackets: MarginBracket[] = USDT_MARGIN_BRACKETS,
): Decimal {
  const n = new Decimal(notional);
  if (n.lte(0)) return new Decimal(0);

  let selected = brackets[0]!;
  for (const b of brackets) {
    if (n.gte(b.notionalFloor)) selected = b;
    else break;
  }

  const mm = n.mul(selected.mmr).minus(selected.cum);
  return Decimal.max(new Decimal(0), mm);
}

/** Sum maintenance margin across open legs. */
export function calcTotalMaintenanceMargin(
  openNotionals: Array<Decimal | string>,
  brackets: MarginBracket[] = USDT_MARGIN_BRACKETS,
): Decimal {
  let total = new Decimal(0);
  for (const n of openNotionals) {
    total = total.plus(calcMaintenanceMarginFromNotional(n, brackets));
  }
  return total;
}
