/**
 * Pure directional-grid math (Decimal.js). Non-compounded levels; 1..N weights per side.
 */
import Decimal from 'decimal.js';
import type { SymbolInfo, TradeSide } from '../../../types';
import { adjustPrice } from '../../utils/precision';
import { calcQuantityFromNotional } from '../../calc/allocation';
import { calcPositionNotional } from '../../calc/leverage';

export type GridDirection = TradeSide;

export interface GridLevelPlan {
  level: number;
  direction: GridDirection;
  weight: number;
  triggerPrice: string;
  limitPrice: string;
  /** Theoretical margin before exchange qty rounding. */
  theoreticalMargin: string;
  /** Actual margin after qty normalization (notional / trigger). */
  allocatedMargin: string;
  notional: string;
  quantity: string;
}

export interface GridPlanResult {
  startPrice: string;
  levelsPerSide: number;
  distancePercent: string;
  totalWeight: number;
  baseUnit: string;
  traderAllocation: string;
  leverage: number;
  levels: GridLevelPlan[];
  /** Sum of actual allocated margins (≤ traderAllocation). */
  totalAllocatedMargin: string;
}

/** Sum 1+2+...+n */
export function triangularWeight(n: number): number {
  const levels = Math.max(1, Math.floor(n));
  return (levels * (levels + 1)) / 2;
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
 * Limit = trigger, tick-adjusted; ensure BUY limit ≥ stop and SELL limit ≤ stop by ±1 tick if needed.
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

export function buildGridLevelPrices(
  startPrice: string,
  levelsPerSide: number,
  distancePercent: string | number,
  symbolInfo: SymbolInfo,
): Array<{ level: number; direction: GridDirection; triggerPrice: string; limitPrice: string; weight: number }> {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const out: Array<{ level: number; direction: GridDirection; triggerPrice: string; limitPrice: string; weight: number }> = [];
  for (const direction of ['LONG', 'SHORT'] as GridDirection[]) {
    for (let level = 1; level <= n; level++) {
      const raw = calcGridTriggerPrice(startPrice, level, direction, distancePercent);
      const triggerPrice = adjustPrice(raw, symbolInfo);
      const limitPrice = calcGridLimitPrice(triggerPrice, direction, symbolInfo);
      out.push({ level, direction, triggerPrice, limitPrice, weight: level });
    }
  }
  return out;
}

/**
 * Allocate margins with weights 1..N per side (total weight = 2 * triangular(N)).
 * After qty rounding, scale down if sum exceeds allocation (deterministic).
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
  const sideWeight = triangularWeight(n);
  const totalWeight = sideWeight * 2;
  const baseUnit = allocation.div(totalWeight);
  const priceRows = buildGridLevelPrices(
    params.startPrice,
    n,
    params.distancePercent,
    params.symbolInfo,
  );

  const levels: GridLevelPlan[] = [];
  for (const row of priceRows) {
    const theoreticalMargin = baseUnit.mul(row.weight);
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
      theoreticalMargin: theoreticalMargin.toFixed(8),
      allocatedMargin: allocatedMargin.toFixed(8),
      notional: notional.toFixed(8),
      quantity,
    });
  }

  // Cap: if total actual margin > allocation, scale quantities down proportionally then re-adjust
  let totalAllocated = levels.reduce((s, l) => s.plus(l.allocatedMargin), new Decimal(0));
  if (totalAllocated.gt(allocation) && totalAllocated.gt(0)) {
    const scale = allocation.div(totalAllocated);
    for (const level of levels) {
      const scaledNotional = new Decimal(level.notional).mul(scale);
      try {
        level.quantity = calcQuantityFromNotional(scaledNotional, level.triggerPrice, params.symbolInfo);
      } catch {
        level.quantity = '0';
      }
      const notional = new Decimal(level.quantity).mul(level.triggerPrice);
      level.notional = notional.toFixed(8);
      level.allocatedMargin = notional.div(lev).toFixed(8);
    }
    totalAllocated = levels.reduce((s, l) => s.plus(l.allocatedMargin), new Decimal(0));
  }

  return {
    startPrice: adjustPrice(params.startPrice, params.symbolInfo),
    levelsPerSide: n,
    distancePercent: String(params.distancePercent),
    totalWeight,
    baseUnit: baseUnit.toFixed(8),
    traderAllocation: allocation.toFixed(8),
    leverage: lev,
    levels,
    totalAllocatedMargin: totalAllocated.toFixed(8),
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
