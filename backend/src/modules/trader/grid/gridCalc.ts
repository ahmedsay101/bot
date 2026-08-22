/**
 * Pure directional-grid math (Decimal.js).
 * Hold-to-exhaustion: no position TP/SL.
 * Capital: trader allocation split 50/50; each side uses L / triangular(N).
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

/** Trader capital is split equally across LONG and SHORT pools. */
export const SIDE_CAPITAL_SPLIT = 2;
/** @deprecated alias — prefer SIDE_CAPITAL_SPLIT */
export const GRID_SIDE_PAIR_FACTOR = SIDE_CAPITAL_SPLIT;
export const DEFAULT_MAX_OPEN_POSITIONS = SIDE_CAPITAL_SPLIT;

export interface GridLevelPlan {
  level: number;
  direction: GridDirection;
  weight: number;
  allocationPct: string;
  triggerPrice: string;
  limitPrice: string;
  /** Unused in hold-to-exhaustion strategy (kept for DB compat). */
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
  longSideCapital: string;
  shortSideCapital: string;
  leverage: number;
  levels: GridLevelPlan[];
}

export function triangularWeight(n: number): number {
  const levels = Math.max(1, Math.floor(n));
  return (levels * (levels + 1)) / 2;
}

/** Ascending weight: Level L weight = L (closest = smallest). */
export function levelWeight(level: number, levelsPerSide: number): number {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const L = Math.min(Math.max(1, Math.floor(level)), n);
  return L;
}

/** Half of trader allocation reserved for one side. */
export function sideCapitalFromTrader(traderAllocation: string | Decimal): Decimal {
  return Decimal.max(new Decimal(0), new Decimal(traderAllocation)).div(SIDE_CAPITAL_SPLIT);
}

/**
 * Fraction of **side** capital for level L.
 * pct = L / triangular(N)  → N=10: L1=1/55 … L10=10/55
 */
export function levelAllocationFraction(
  level: number,
  levelsPerSide: number,
  _maxOpenPositions?: number,
): Decimal {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const total = triangularWeight(n);
  if (total <= 0) return new Decimal(0);
  return new Decimal(levelWeight(level, n)).div(total);
}

/**
 * Margin for a level from a **side** capital pool.
 * margin = sideCapital × (L / triangular(N))
 */
export function calculatePositionAllocation(
  sideCapital: string | Decimal,
  level: number,
  levelsPerSide: number,
  _maxOpenPositions?: number,
): Decimal {
  const capital = Decimal.max(new Decimal(0), new Decimal(sideCapital));
  return capital.mul(levelAllocationFraction(level, levelsPerSide));
}

export function calcGridDistanceAbs(
  startPrice: string | Decimal,
  distancePercent: string | number,
): Decimal {
  return new Decimal(startPrice).mul(new Decimal(distancePercent).div(100)).abs();
}

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

export function resolveGridDistanceAbs(params: {
  levels?: Array<{ level: number; direction: string; triggerPrice: string }>;
  startPrice?: string | Decimal | null;
  distancePercent?: string | number | null;
  storedAbs?: string | Decimal | null;
}): Decimal {
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

/**
 * Destruction threshold ONE grid-spacing % beyond the final LONG trigger.
 * upperDestroy = lastLongLevel × (1 + spacingPercent/100)
 * Trader stays alive while price <= threshold; destroy when price > threshold.
 */
export function getUpperGridExhaustionPrice(
  lastLongLevel: string | Decimal,
  gridSpacingPercent: string | number,
): Decimal {
  const last = new Decimal(lastLongLevel);
  const pct = new Decimal(gridSpacingPercent).div(100);
  return last.mul(new Decimal(1).plus(pct));
}

/**
 * Destruction threshold ONE grid-spacing % beyond the final SHORT trigger.
 * lowerDestroy = lastShortLevel × (1 - spacingPercent/100)
 * Trader stays alive while price >= threshold; destroy when price < threshold.
 */
export function getLowerGridExhaustionPrice(
  lastShortLevel: string | Decimal,
  gridSpacingPercent: string | number,
): Decimal {
  const last = new Decimal(lastShortLevel);
  const pct = new Decimal(gridSpacingPercent).div(100);
  const out = last.mul(new Decimal(1).minus(pct));
  if (out.lte(0)) {
    throw new Error(`Lower exhaustion non-positive for last=${last.toFixed()} spacing=${gridSpacingPercent}`);
  }
  return out;
}

/** Strict `>` — exact upper threshold keeps trader alive. */
export function isPricePastUpperExhaustion(
  price: string | Decimal,
  lastLongLevel: string | Decimal,
  gridSpacingPercent: string | number,
): boolean {
  return new Decimal(price).gt(getUpperGridExhaustionPrice(lastLongLevel, gridSpacingPercent));
}

/** Strict `<` — exact lower threshold keeps trader alive. */
export function isPricePastLowerExhaustion(
  price: string | Decimal,
  lastShortLevel: string | Decimal,
  gridSpacingPercent: string | number,
): boolean {
  return new Decimal(price).lt(getLowerGridExhaustionPrice(lastShortLevel, gridSpacingPercent));
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

/** @deprecated No position TP in hold-to-exhaustion; retained for tests/compat. */
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
      const frac = levelAllocationFraction(level, n);
      out.push({
        level,
        direction,
        triggerPrice,
        limitPrice,
        tpPrice: '',
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
  const longSide = sideCapitalFromTrader(allocation);
  const shortSide = sideCapitalFromTrader(allocation);
  const lev = Math.max(1, params.leverage);
  const startAdj = adjustPrice(params.startPrice, params.symbolInfo);
  const distAbs = calcGridDistanceAbs(startAdj, params.distancePercent);
  const priceRows = buildGridLevelPrices(startAdj, n, params.distancePercent, params.symbolInfo);

  const levels: GridLevelPlan[] = [];
  for (const row of priceRows) {
    const sideCap = row.direction === 'LONG' ? longSide : shortSide;
    const theoreticalMargin = calculatePositionAllocation(sideCap, row.level, n);
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
      tpPrice: '',
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
    longSideCapital: longSide.toFixed(8),
    shortSideCapital: shortSide.toFixed(8),
    leverage: lev,
    levels,
  };
}

export function sizeLevelPosition(params: {
  /** Side capital pool (not full trader capital). */
  sideCapital?: string | Decimal;
  /** @deprecated use sideCapital */
  currentCapital?: string | Decimal;
  level: number;
  levelsPerSide: number;
  leverage: number;
  entryPrice: string;
  symbolInfo: SymbolInfo;
}): { allocatedMargin: string; notional: string; quantity: string; weight: number; allocationPct: string } {
  const lev = Math.max(1, params.leverage);
  const weight = levelWeight(params.level, params.levelsPerSide);
  const frac = levelAllocationFraction(params.level, params.levelsPerSide);
  const pool = params.sideCapital ?? params.currentCapital ?? '0';
  const margin = calculatePositionAllocation(pool, params.level, params.levelsPerSide);
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

export function calcTraderTpTarget(
  initialCapital: string | Decimal,
  takeProfitPercent: string | Decimal,
): Decimal {
  return new Decimal(initialCapital).mul(new Decimal(takeProfitPercent)).div(100);
}

export function isTraderTpReached(
  netPnl: string | Decimal,
  initialCapital: string | Decimal,
  takeProfitPercent: string | Decimal,
): boolean {
  const target = calcTraderTpTarget(initialCapital, takeProfitPercent);
  if (target.lte(0)) return false;
  return new Decimal(netPnl).gte(target);
}

export function isLevelTerminal(status: string): boolean {
  return status === 'TP_HIT' || status === 'SL_HIT' || status === 'CANCELLED' || status === 'SKIPPED';
}

/** Level counts toward grid exhaustion once filled/open (ACTIVE). */
export function isLevelExhaustionCounted(status: string): boolean {
  return status === 'ACTIVE' || status === 'TP_HIT';
}

export function isLevelTpComplete(status: string): boolean {
  return status === 'TP_HIT';
}
