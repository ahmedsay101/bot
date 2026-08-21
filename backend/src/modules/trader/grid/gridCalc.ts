/**
 * Pure directional-grid math (Decimal.js).
 * No SL. Capital scales deeper: L1 smallest (5%), LN largest (50%) with maxOpen=2.
 * At most one open position per side (enforced by trader, not config).
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
  | 'CANCELLED'
  | 'SKIPPED'
  /** @deprecated historical only — new traders never write SL_HIT */
  | 'SL_HIT';

/** Max simultaneous opens (1 LONG + 1 SHORT). Used in allocation ÷ factor. */
export const GRID_SIDE_PAIR_FACTOR = 2;
export const DEFAULT_MAX_OPEN_POSITIONS = GRID_SIDE_PAIR_FACTOR;

export interface GridLevelPlan {
  level: number;
  direction: GridDirection;
  weight: number;
  allocationPct: string;
  triggerPrice: string;
  limitPrice: string;
  tpPrice: string;
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

export function triangularWeight(n: number): number {
  const levels = Math.max(1, Math.floor(n));
  return (levels * (levels + 1)) / 2;
}

/**
 * Ascending weight: Level L weight = L (L1 smallest, LN largest).
 */
export function levelWeight(level: number, levelsPerSide: number): number {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const L = Math.min(Math.max(1, Math.floor(level)), n);
  return L;
}

/**
 * Allocation fraction of current capital.
 * pct = levelNumber / N / maxOpenPositions
 * With N=10, maxOpen=2 → L1=0.05 … L10=0.50
 */
export function levelAllocationFraction(
  level: number,
  levelsPerSide: number,
  maxOpenPositions: number = DEFAULT_MAX_OPEN_POSITIONS,
): Decimal {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const maxOpen = Math.max(1, Math.floor(maxOpenPositions));
  return new Decimal(levelWeight(level, n)).div(n).div(maxOpen);
}

/**
 * Margin for a level from current trader capital.
 * margin = currentCapital × (level / N / maxOpen)
 */
export function calculatePositionAllocation(
  currentCapital: string | Decimal,
  level: number,
  levelsPerSide: number,
  maxOpenPositions: number = DEFAULT_MAX_OPEN_POSITIONS,
): Decimal {
  const capital = Decimal.max(new Decimal(0), new Decimal(currentCapital));
  return capital.mul(levelAllocationFraction(level, levelsPerSide, maxOpenPositions));
}

export function calcGridDistanceAbs(
  startPrice: string | Decimal,
  distancePercent: string | number,
): Decimal {
  return new Decimal(startPrice).mul(new Decimal(distancePercent).div(100)).abs();
}

/**
 * Immutable one-step spacing from the built ladder (preferred over percent × start).
 * Uses |trigger(L2) − trigger(L1)| on either side so TP never drifts if config % changes.
 */
export function inferGridDistanceAbsFromTriggers(
  levels: Array<{ level: number; direction: string; triggerPrice: string }>,
): Decimal | null {
  for (const direction of ['LONG', 'SHORT']) {
    const side = levels
      .filter((l) => l.direction === direction)
      .sort((a, b) => a.level - b.level);
    if (side.length < 2) continue;
    const a = new Decimal(side[0]!.triggerPrice);
    const b = new Decimal(side[1]!.triggerPrice);
    const step = a.minus(b).abs();
    if (step.gt(0)) return step;
  }
  return null;
}

/**
 * Resolve the grid step used for position TPs.
 * Prefer ladder-inferred spacing; fall back to start × percent / 100.
 */
export function resolveGridDistanceAbs(params: {
  levels?: Array<{ level: number; direction: string; triggerPrice: string }>;
  startPrice?: string | Decimal | null;
  distancePercent?: string | number | null;
  storedAbs?: string | Decimal | null;
}): Decimal {
  // Ladder spacing is the source of truth (survives config % drift)
  if (params.levels != null && params.levels.length > 0) {
    const inferred = inferGridDistanceAbsFromTriggers(params.levels);
    if (inferred != null) return inferred;
  }
  if (params.storedAbs != null && new Decimal(params.storedAbs).gt(0)) {
    return new Decimal(params.storedAbs).abs();
  }
  if (params.startPrice != null && params.distancePercent != null) {
    return calcGridDistanceAbs(params.startPrice, params.distancePercent);
  }
  throw new Error('Cannot resolve gridDistanceAbs: no levels, storedAbs, or start/percent');
}

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
  weight: number;
  allocationPct: string;
}> {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const startAdj = adjustPrice(startPrice, symbolInfo);
  const distAbs = calcGridDistanceAbs(startAdj, distancePercent);
  const out: Array<{
    level: number;
    direction: GridDirection;
    triggerPrice: string;
    limitPrice: string;
    tpPrice: string;
    weight: number;
    allocationPct: string;
  }> = [];
  for (const direction of ['LONG', 'SHORT'] as GridDirection[]) {
    for (let level = 1; level <= n; level++) {
      const raw = calcGridTriggerPrice(startAdj, level, direction, distancePercent);
      const triggerPrice = adjustPrice(raw, symbolInfo);
      const limitPrice = calcGridLimitPrice(triggerPrice, direction, symbolInfo);
      const tpPrice = calcLevelTpPrice(triggerPrice, direction, distAbs, symbolInfo);
      const frac = levelAllocationFraction(level, n);
      out.push({
        level,
        direction,
        triggerPrice,
        limitPrice,
        tpPrice,
        weight: levelWeight(level, n),
        allocationPct: frac.toFixed(8),
      });
    }
  }
  return out;
}

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
  const priceRows = buildGridLevelPrices(startAdj, n, params.distancePercent, params.symbolInfo);

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
      allocationPct: row.allocationPct,
      triggerPrice: row.triggerPrice,
      limitPrice: row.limitPrice,
      tpPrice: row.tpPrice,
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

export function sizeLevelPosition(params: {
  currentCapital: string | Decimal;
  level: number;
  levelsPerSide: number;
  leverage: number;
  entryPrice: string;
  symbolInfo: SymbolInfo;
}): { allocatedMargin: string; notional: string; quantity: string; weight: number; allocationPct: string } {
  const lev = Math.max(1, params.leverage);
  const weight = levelWeight(params.level, params.levelsPerSide);
  const frac = levelAllocationFraction(params.level, params.levelsPerSide);
  const margin = calculatePositionAllocation(params.currentCapital, params.level, params.levelsPerSide);
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
    allocationPct: frac.toFixed(8),
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

export function isLevelTpComplete(status: string): boolean {
  return status === 'TP_HIT';
}
