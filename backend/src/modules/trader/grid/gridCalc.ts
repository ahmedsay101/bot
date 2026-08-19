/**
 * Pure directional-grid math (Decimal.js).
 * Single-position model: reversed weights (L1 largest), absolute TP spacing, SL = start.
 */
import Decimal from 'decimal.js';
import type { SymbolInfo, TradeSide } from '../../../types';
import { adjustPrice } from '../../utils/precision';
import { calcQuantityFromNotional } from '../../calc/allocation';
import { calcPositionNotional } from '../../calc/leverage';

export type GridDirection = TradeSide;

export type GridLevelStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'TP_HIT'
  | 'SL_HIT'
  | 'CANCELLED'
  | 'SKIPPED';

export interface GridLevelPlan {
  level: number;
  direction: GridDirection;
  /** Reversed weight: L1 = N, L10 = 1 */
  weight: number;
  triggerPrice: string;
  limitPrice: string;
  /** Take-profit price (entry ± gridDistance); set at plan from trigger as estimate. */
  tpPrice: string;
  /** Always startPrice. */
  slPrice: string;
  /** Display-only estimate at init (uses initial capital); real size at activation. */
  theoreticalMargin: string;
  allocatedMargin: string;
  notional: string;
  quantity: string;
}

export interface GridPlanResult {
  startPrice: string;
  levelsPerSide: number;
  distancePercent: string;
  gridDistanceAbs: string;
  totalWeight: number;
  traderAllocation: string;
  leverage: number;
  levels: GridLevelPlan[];
}

/** Sum 1+2+...+n */
export function triangularWeight(n: number): number {
  const levels = Math.max(1, Math.floor(n));
  return (levels * (levels + 1)) / 2;
}

/** Formula B: Level L weight = N − L + 1 (L1 largest). */
export function levelWeight(level: number, levelsPerSide: number): number {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const L = Math.min(Math.max(1, Math.floor(level)), n);
  return n - L + 1;
}

/**
 * Margin for the active level from current trader capital.
 * margin = currentCapital × weight(L) / N
 */
export function calculatePositionAllocation(
  currentCapital: string | Decimal,
  level: number,
  levelsPerSide: number,
): Decimal {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const w = levelWeight(level, n);
  const capital = Decimal.max(new Decimal(0), new Decimal(currentCapital));
  return capital.mul(w).div(n);
}

/** Absolute grid step in price units: start × pct/100 (non-compounded). */
export function calcGridDistanceAbs(
  startPrice: string | Decimal,
  distancePercent: string | number,
): Decimal {
  return new Decimal(startPrice).mul(new Decimal(distancePercent).div(100)).abs();
}

/** Non-compounded trigger from immutable start price. */
export function calcGridTriggerPrice(
  startPrice: string | Decimal,
  level: number,
  direction: GridDirection,
  distancePercent: string | number,
): Decimal {
  const start = new Decimal(startPrice);
  const L = Math.max(1, Math.floor(level));
  const dist = new Decimal(distancePercent).div(100);
  const factor = direction === 'LONG'
    ? new Decimal(1).plus(dist.mul(L))
    : new Decimal(1).minus(dist.mul(L));
  const px = start.mul(factor);
  if (px.lte(0)) {
    throw new Error(`Grid trigger non-positive for ${direction} L${L}: ${px.toFixed()}`);
  }
  return px;
}

/**
 * Limit = trigger, tick-adjusted; BUY limit ≥ stop, SELL limit ≤ stop.
 */
export function calcGridLimitPrice(
  triggerPrice: string,
  direction: GridDirection,
  symbolInfo: SymbolInfo,
): string {
  let limit = adjustPrice(triggerPrice, symbolInfo);
  const stop = new Decimal(triggerPrice);
  const lim = new Decimal(limit);
  const tick = new Decimal(symbolInfo.tickSize);
  if (direction === 'LONG' && lim.lt(stop)) {
    limit = adjustPrice(stop.plus(tick), symbolInfo);
  } else if (direction === 'SHORT' && lim.gt(stop)) {
    limit = adjustPrice(Decimal.max(tick, stop.minus(tick)), symbolInfo);
  }
  return limit;
}

/** TP = entry ± one absolute grid distance (not compounded %). */
export function calcLevelTpPrice(
  entryPrice: string | Decimal,
  direction: GridDirection,
  gridDistanceAbs: string | Decimal,
  symbolInfo: SymbolInfo,
): string {
  const entry = new Decimal(entryPrice);
  const step = new Decimal(gridDistanceAbs).abs();
  const raw = direction === 'LONG' ? entry.plus(step) : entry.minus(step);
  if (raw.lte(0)) {
    throw new Error(`TP non-positive for ${direction} entry=${entry.toFixed()}`);
  }
  return adjustPrice(raw, symbolInfo);
}

/** SL is always the immutable start price. */
export function calcLevelSlPrice(startPrice: string | Decimal, symbolInfo: SymbolInfo): string {
  return adjustPrice(startPrice, symbolInfo);
}

export function buildGridLevelPrices(
  startPrice: string,
  levelsPerSide: number,
  distancePercent: string | number,
  symbolInfo: SymbolInfo,
): Array<{
  level: number;
  direction: GridDirection;
  triggerPrice: string;
  limitPrice: string;
  tpPrice: string;
  slPrice: string;
  weight: number;
}> {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const startAdj = adjustPrice(startPrice, symbolInfo);
  const distAbs = calcGridDistanceAbs(startAdj, distancePercent);
  const slPrice = calcLevelSlPrice(startAdj, symbolInfo);
  const out: Array<{
    level: number;
    direction: GridDirection;
    triggerPrice: string;
    limitPrice: string;
    tpPrice: string;
    slPrice: string;
    weight: number;
  }> = [];
  for (const direction of ['LONG', 'SHORT'] as GridDirection[]) {
    for (let level = 1; level <= n; level++) {
      const raw = calcGridTriggerPrice(startAdj, level, direction, distancePercent);
      const triggerPrice = adjustPrice(raw, symbolInfo);
      const limitPrice = calcGridLimitPrice(triggerPrice, direction, symbolInfo);
      // Estimate TP from trigger (actual TP uses fill price at activation)
      const tpPrice = calcLevelTpPrice(triggerPrice, direction, distAbs, symbolInfo);
      out.push({
        level,
        direction,
        triggerPrice,
        limitPrice,
        tpPrice,
        slPrice,
        weight: levelWeight(level, n),
      });
    }
  }
  return out;
}

/**
 * Build price skeleton + display size estimates from initial capital.
 * Real margin/qty computed at activation via calculatePositionAllocation(currentCapital, …).
 */
export function buildGridPlan(params: {
  startPrice: string;
  traderAllocation: string | Decimal;
  leverage: number;
  levelsPerSide: number;
  distancePercent: string | number;
  symbolInfo: SymbolInfo;
}): GridPlanResult {
  const n = Math.max(1, Math.floor(params.levelsPerSide));
  const allocation = new Decimal(params.traderAllocation);
  const lev = Math.max(1, params.leverage);
  const startAdj = adjustPrice(params.startPrice, params.symbolInfo);
  const distAbs = calcGridDistanceAbs(startAdj, params.distancePercent);
  const priceRows = buildGridLevelPrices(
    startAdj,
    n,
    params.distancePercent,
    params.symbolInfo,
  );

  const levels: GridLevelPlan[] = [];
  for (const row of priceRows) {
    const theoreticalMargin = calculatePositionAllocation(allocation, row.level, n);
    const theoreticalNotional = calcPositionNotional(theoreticalMargin, lev);
    let quantity: string;
    try {
      quantity = calcQuantityFromNotional(theoreticalNotional, row.triggerPrice, params.symbolInfo);
    } catch {
      quantity = '0';
    }
    const qty = new Decimal(quantity);
    const notional = qty.mul(row.triggerPrice);
    const allocatedMargin = lev > 0 ? notional.div(lev) : notional;
    levels.push({
      level: row.level,
      direction: row.direction,
      weight: row.weight,
      triggerPrice: row.triggerPrice,
      limitPrice: row.limitPrice,
      tpPrice: row.tpPrice,
      slPrice: row.slPrice,
      theoreticalMargin: theoreticalMargin.toFixed(8),
      allocatedMargin: allocatedMargin.toFixed(8),
      notional: notional.toFixed(8),
      quantity,
    });
  }

  return {
    startPrice: startAdj,
    levelsPerSide: n,
    distancePercent: String(params.distancePercent),
    gridDistanceAbs: distAbs.toFixed(8),
    totalWeight: triangularWeight(n),
    traderAllocation: allocation.toFixed(8),
    leverage: lev,
    levels,
  };
}

/** Size a single activation from current capital. */
export function sizeLevelPosition(params: {
  currentCapital: string | Decimal;
  level: number;
  levelsPerSide: number;
  leverage: number;
  entryPrice: string;
  symbolInfo: SymbolInfo;
}): { allocatedMargin: string; notional: string; quantity: string; weight: number } {
  const lev = Math.max(1, params.leverage);
  const weight = levelWeight(params.level, params.levelsPerSide);
  const margin = calculatePositionAllocation(
    params.currentCapital,
    params.level,
    params.levelsPerSide,
  );
  const theoreticalNotional = calcPositionNotional(margin, lev);
  let quantity: string;
  try {
    quantity = calcQuantityFromNotional(theoreticalNotional, params.entryPrice, params.symbolInfo);
  } catch {
    quantity = '0';
  }
  const notional = new Decimal(quantity).mul(params.entryPrice);
  const allocatedMargin = lev > 0 ? notional.div(lev) : notional;
  return {
    allocatedMargin: allocatedMargin.toFixed(8),
    notional: notional.toFixed(8),
    quantity,
    weight,
  };
}

export function traderProfitPercent(
  netProfit: string | Decimal,
  traderAllocation: string | Decimal,
): Decimal {
  const alloc = new Decimal(traderAllocation);
  if (alloc.isZero()) return new Decimal(0);
  return new Decimal(netProfit).div(alloc).mul(100);
}

export function isLevelTerminal(status: string): boolean {
  return status === 'TP_HIT' || status === 'SL_HIT' || status === 'CANCELLED' || status === 'SKIPPED';
}
