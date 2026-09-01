/**
 * Near-price directional grid — pure math.
 *
 * Levels are permanent price anchors (not pre-assigned LONG/SHORT).
 * Target reconcile: up to 2 nearest EMPTY+in-zone levels ABOVE mark → LONG,
 *                   up to 2 nearest EMPTY+in-zone levels BELOW mark → SHORT.
 * Activation: mark within (spacing% × activationMultiplier) of levelPrice,
 *   distancePercent = abs(mark - level) / level × 100  (reference = level price).
 * Side rule (counter-directional):
 *   mark < level  → LONG
 *   mark >= level → SHORT  (exact equality is SHORT — deterministic)
 * Boundaries: start × (1 ± boundary%/100); destroy when mark is strictly outside.
 * TP: ± spacing% from actual entry; no SL.
 * After TP the level returns to EMPTY and may be reassigned immediately.
 */
import Decimal from 'decimal.js';
import type { SymbolInfo, TradeSide } from '../../../types';
import { adjustPrice } from '../../utils/precision';
import { calcQuantityFromNotional } from '../../calc/allocation';
import { calcPositionNotional } from '../../calc/leverage';
import { equalCapitalPerLevel, sizeLevelPosition, totalGridLevels } from '../grid/gridCalc';

export type NearPriceLevelStatus =
  | 'EMPTY'
  | 'PENDING'
  | 'ACTIVE'
  | 'TP_HIT'
  | 'CANCELLED'
  | 'SKIPPED';

export interface NearPriceGridConfig {
  boundaryPercent: string | number;
  spacingPercent: string | number;
  /** Activation distance = spacing × multiplier (default 2 → 4% when spacing=2%). */
  activationMultiplier: string | number;
  /** Limit offset from stop for STOP_LIMIT (percent points). */
  stopLimitOffsetPercent: string | number;
}

export interface NearPriceLevelPlan {
  /** 1-based index in price-sorted grid (lowest price = 1). */
  level: number;
  /** Geometric side relative to start at creation. */
  geometry: 'ABOVE' | 'BELOW';
  /** Steps from start (1 = nearest). */
  step: number;
  levelPrice: string;
  status: NearPriceLevelStatus;
}

export function parsePositivePercent(value: string | number, name: string): Decimal {
  const d = new Decimal(value);
  if (!d.isFinite() || d.lte(0)) {
    throw new Error(`${name} must be > 0 (got ${value})`);
  }
  return d;
}

/** Levels per side = floor(boundary% / spacing%). */
export function levelsPerSideFromConfig(
  boundaryPercent: string | number,
  spacingPercent: string | number,
): number {
  const b = parsePositivePercent(boundaryPercent, 'GRID_BOUNDARY_PERCENT');
  const s = parsePositivePercent(spacingPercent, 'GRID_SPACING_PERCENT');
  const n = Math.floor(b.div(s).toNumber());
  if (n < 1) {
    throw new Error(
      `Invalid near-price grid: boundary ${b}% / spacing ${s}% yields ${n} levels per side`,
    );
  }
  return n;
}

export function calcUpperBound(startPrice: string | Decimal, boundaryPercent: string | number): Decimal {
  const start = new Decimal(startPrice);
  const b = parsePositivePercent(boundaryPercent, 'GRID_BOUNDARY_PERCENT').div(100);
  return start.mul(new Decimal(1).plus(b));
}

export function calcLowerBound(startPrice: string | Decimal, boundaryPercent: string | number): Decimal {
  const start = new Decimal(startPrice);
  const b = parsePositivePercent(boundaryPercent, 'GRID_BOUNDARY_PERCENT').div(100);
  return start.mul(new Decimal(1).minus(b));
}

/** Strictly past upper bound (touch == does NOT destroy). */
export function isPastUpperBound(markPrice: string | Decimal, upperBound: string | Decimal): boolean {
  return new Decimal(markPrice).gt(upperBound);
}

/** Strictly past lower bound (touch == does NOT destroy). */
export function isPastLowerBound(markPrice: string | Decimal, lowerBound: string | Decimal): boolean {
  return new Decimal(markPrice).lt(lowerBound);
}

export function isOutsideGridBoundary(
  markPrice: string | Decimal,
  lowerBound: string | Decimal,
  upperBound: string | Decimal,
): boolean {
  return isPastUpperBound(markPrice, upperBound) || isPastLowerBound(markPrice, lowerBound);
}

/**
 * Gap-safe boundary breach: current is outside, OR jump crossed the bound
 * between previous and current.
 */
export function didCrossOutsideBoundary(
  previousPrice: string | Decimal,
  currentPrice: string | Decimal,
  lowerBound: string | Decimal,
  upperBound: string | Decimal,
): boolean {
  if (isOutsideGridBoundary(currentPrice, lowerBound, upperBound)) return true;
  const prev = new Decimal(previousPrice);
  const curr = new Decimal(currentPrice);
  const lo = new Decimal(lowerBound);
  const hi = new Decimal(upperBound);
  // Crossed upper upward
  if (prev.lte(hi) && curr.gt(hi)) return true;
  // Crossed lower downward
  if (prev.gte(lo) && curr.lt(lo)) return true;
  return false;
}

export function calcLevelPrice(
  startPrice: string | Decimal,
  step: number,
  geometry: 'ABOVE' | 'BELOW',
  spacingPercent: string | number,
): Decimal {
  const start = new Decimal(startPrice);
  const s = parsePositivePercent(spacingPercent, 'GRID_SPACING_PERCENT').div(100);
  const factor = s.mul(step);
  return geometry === 'ABOVE'
    ? start.mul(new Decimal(1).plus(factor))
    : start.mul(new Decimal(1).minus(factor));
}

export function activationDistancePercent(
  spacingPercent: string | number,
  activationMultiplier: string | number,
): Decimal {
  const s = parsePositivePercent(spacingPercent, 'GRID_SPACING_PERCENT');
  const m = parsePositivePercent(activationMultiplier, 'GRID_ACTIVATION_MULTIPLIER');
  return s.mul(m);
}

/**
 * Percent distance from level price: abs(mark - level) / level × 100.
 * Reference price = levelPrice (documented).
 */
export function distancePercentFromLevel(
  markPrice: string | Decimal,
  levelPrice: string | Decimal,
): Decimal {
  const level = new Decimal(levelPrice);
  if (level.isZero()) return new Decimal(Infinity);
  return new Decimal(markPrice).minus(level).abs().div(level).mul(100);
}

export function isWithinActivationZone(
  markPrice: string | Decimal,
  levelPrice: string | Decimal,
  spacingPercent: string | number,
  activationMultiplier: string | number,
): boolean {
  const dist = distancePercentFromLevel(markPrice, levelPrice);
  const max = activationDistancePercent(spacingPercent, activationMultiplier);
  return dist.lte(max);
}

/**
 * Counter-directional side assignment.
 * mark < level → LONG; mark >= level → SHORT.
 */
export function assignSideForLevel(
  markPrice: string | Decimal,
  levelPrice: string | Decimal,
): TradeSide {
  return new Decimal(markPrice).lt(levelPrice) ? 'LONG' : 'SHORT';
}

export function isNearPriceLevelTerminal(status: string): boolean {
  // TP does NOT kill a level — levels are reusable. Only cancelled/skipped are terminal.
  return status === 'CANCELLED' || status === 'SKIPPED';
}

/** After TP, level returns to EMPTY/AVAILABLE (not permanently dead). */
export function resetLevelAfterTpClose(): {
  status: 'EMPTY';
  direction: null;
  clientOrderId: null;
  exchangeOrderId: null;
  entryPrice: null;
  filledQuantity: null;
  tpPrice: null;
  allocatedMargin: string;
  notional: string;
  quantity: string;
} {
  return {
    status: 'EMPTY',
    direction: null,
    clientOrderId: null,
    exchangeOrderId: null,
    entryPrice: null,
    filledQuantity: null,
    tpPrice: null,
    allocatedMargin: '0',
    notional: '0',
    quantity: '0',
  };
}

export function buildNearPriceLevelPlans(params: {
  startPrice: string;
  boundaryPercent: string | number;
  spacingPercent: string | number;
  symbolInfo: SymbolInfo;
}): NearPriceLevelPlan[] {
  const n = levelsPerSideFromConfig(params.boundaryPercent, params.spacingPercent);
  const startAdj = adjustPrice(params.startPrice, params.symbolInfo);
  const rows: NearPriceLevelPlan[] = [];
  let idx = 0;
  // Build below (far → near) then above (near → far) later sorted by price
  for (let step = n; step >= 1; step--) {
    idx += 1;
    const raw = calcLevelPrice(startAdj, step, 'BELOW', params.spacingPercent);
    rows.push({
      level: idx,
      geometry: 'BELOW',
      step,
      levelPrice: adjustPrice(raw.toFixed(8), params.symbolInfo),
      status: 'EMPTY',
    });
  }
  for (let step = 1; step <= n; step++) {
    idx += 1;
    const raw = calcLevelPrice(startAdj, step, 'ABOVE', params.spacingPercent);
    rows.push({
      level: idx,
      geometry: 'ABOVE',
      step,
      levelPrice: adjustPrice(raw.toFixed(8), params.symbolInfo),
      status: 'EMPTY',
    });
  }
  // Re-number 1..N by ascending price for stable display
  rows.sort((a, b) => new Decimal(a.levelPrice).cmp(new Decimal(b.levelPrice)));
  return rows.map((r, i) => ({ ...r, level: i + 1 }));
}

/** Closest-to-mark first; tie-break by lower level number. */
export function sortEligibleByProximity<T extends { levelPrice: string; level: number }>(
  levels: T[],
  markPrice: string | Decimal,
): T[] {
  const mark = new Decimal(markPrice);
  return [...levels].sort((a, b) => {
    const da = mark.minus(a.levelPrice).abs();
    const db = mark.minus(b.levelPrice).abs();
    const cmp = da.cmp(db);
    if (cmp !== 0) return cmp;
    return a.level - b.level;
  });
}

export function findEligibleEmptyLevels<T extends {
  level: number;
  levelPrice: string;
  status: string;
  clientOrderId?: string | null;
}>(
  levels: T[],
  markPrice: string | Decimal,
  spacingPercent: string | number,
  activationMultiplier: string | number,
): T[] {
  const eligible = levels.filter(
    (l) =>
      l.status === 'EMPTY'
      && l.clientOrderId == null
      && isWithinActivationZone(markPrice, l.levelPrice, spacingPercent, activationMultiplier),
  );
  return sortEligibleByProximity(eligible, markPrice);
}

/** Default target: 2 nearest levels above (LONG) + 2 nearest below (SHORT). */
export const NEAR_PRICE_MAX_PER_SIDE = 2;

export interface NearPriceTargetLevel<T> {
  level: T;
  side: TradeSide;
  /** Absolute distance from mark to level price. */
  distanceAbs: Decimal;
}

export interface NearPriceTargetSelection<T> {
  markPrice: string;
  above: NearPriceTargetLevel<T>[];
  below: NearPriceTargetLevel<T>[];
  /** above + below (above nearest-first, then below nearest-first). */
  targets: NearPriceTargetLevel<T>[];
}

/**
 * Geometric desired grid around CURRENT mark (authoritative invariant):
 *   - up to maxPerSide levels with price STRICTLY above mark → LONG
 *   - up to maxPerSide levels with price STRICTLY below mark → SHORT
 * Level exactly at mark is in neither set (deterministic).
 *
 * Includes levels of any status (EMPTY/PENDING/ACTIVE) so callers can:
 *   - create missing EMPTY slots
 *   - cancel stale PENDING outside the window / wrong side
 *   - leave ACTIVE filled positions until TP
 */
export function resolveDesiredNearPriceGrid<T extends {
  level: number;
  levelPrice: string;
}>(
  levels: T[],
  markPrice: string | Decimal,
  maxPerSide: number = NEAR_PRICE_MAX_PER_SIDE,
): NearPriceTargetSelection<T> {
  const mark = new Decimal(markPrice);
  const markStr = mark.toFixed();

  const aboveRaw = [...levels]
    .filter((l) => new Decimal(l.levelPrice).gt(mark))
    .sort((a, b) => new Decimal(a.levelPrice).cmp(new Decimal(b.levelPrice)))
    .slice(0, Math.max(0, maxPerSide));

  const belowRaw = [...levels]
    .filter((l) => new Decimal(l.levelPrice).lt(mark))
    .sort((a, b) => new Decimal(b.levelPrice).cmp(new Decimal(a.levelPrice)))
    .slice(0, Math.max(0, maxPerSide));

  const above: NearPriceTargetLevel<T>[] = aboveRaw.map((l) => ({
    level: l,
    side: 'LONG' as const,
    distanceAbs: mark.minus(l.levelPrice).abs(),
  }));
  const below: NearPriceTargetLevel<T>[] = belowRaw.map((l) => ({
    level: l,
    side: 'SHORT' as const,
    distanceAbs: mark.minus(l.levelPrice).abs(),
  }));

  return {
    markPrice: markStr,
    above,
    below,
    targets: [...above, ...below],
  };
}

/**
 * @deprecated Prefer resolveDesiredNearPriceGrid. Kept for tests that filter EMPTY+zone.
 * Selects EMPTY+in-zone only (legacy activation-gated behavior).
 */
export function selectNearestTargetLevels<T extends {
  level: number;
  levelPrice: string;
  status: string;
  clientOrderId?: string | null;
}>(
  levels: T[],
  markPrice: string | Decimal,
  spacingPercent: string | number,
  activationMultiplier: string | number,
  maxPerSide: number = NEAR_PRICE_MAX_PER_SIDE,
): NearPriceTargetSelection<T> {
  const mark = new Decimal(markPrice);
  const emptyInZone = levels.filter(
    (l) =>
      l.status === 'EMPTY'
      && l.clientOrderId == null
      && isWithinActivationZone(mark, l.levelPrice, spacingPercent, activationMultiplier),
  );
  return resolveDesiredNearPriceGrid(emptyInZone, mark, maxPerSide);
}

/**
 * Geometric nearest grid levels by mark (any status) — audit + desired window.
 * Strictly above / strictly below (level == mark is neither).
 */
export function nearestGridLevelsByMark<T extends { level: number; levelPrice: string }>(
  levels: T[],
  markPrice: string | Decimal,
  maxPerSide: number = NEAR_PRICE_MAX_PER_SIDE,
): { above: T[]; below: T[] } {
  const desired = resolveDesiredNearPriceGrid(levels, markPrice, maxPerSide);
  return {
    above: desired.above.map((t) => t.level),
    below: desired.below.map((t) => t.level),
  };
}

/**
 * Gap-safe TP: current mark has reached/passed TP, OR price crossed TP between ticks.
 */
export function didCrossTakeProfit(
  direction: TradeSide,
  previousPrice: string | Decimal,
  currentPrice: string | Decimal,
  tpPrice: string | Decimal,
): boolean {
  const prev = new Decimal(previousPrice);
  const curr = new Decimal(currentPrice);
  const tp = new Decimal(tpPrice);
  if (direction === 'LONG') {
    if (curr.gte(tp)) return true;
    return prev.lt(tp) && curr.gte(tp);
  }
  if (curr.lte(tp)) return true;
  return prev.gt(tp) && curr.lte(tp);
}

/**
 * Gap-safe stop trigger for entry STOP orders.
 * LONG (BUY stop): triggers when mark reaches/passes stop from below.
 * SHORT (SELL stop): triggers when mark reaches/passes stop from above.
 */
export function didCrossStopTrigger(
  side: TradeSide,
  previousPrice: string | Decimal,
  currentPrice: string | Decimal,
  stopPrice: string | Decimal,
): boolean {
  const prev = new Decimal(previousPrice);
  const curr = new Decimal(currentPrice);
  const stop = new Decimal(stopPrice);
  if (side === 'LONG') {
    if (curr.gte(stop)) return true;
    return prev.lt(stop) && curr.gte(stop);
  }
  if (curr.lte(stop)) return true;
  return prev.gt(stop) && curr.lte(stop);
}

export function calcNearPriceTp(
  entryPrice: string | Decimal,
  side: TradeSide,
  spacingPercent: string | number,
  symbolInfo: SymbolInfo,
): string {
  const entry = new Decimal(entryPrice);
  const s = parsePositivePercent(spacingPercent, 'GRID_SPACING_PERCENT').div(100);
  const raw = side === 'LONG'
    ? entry.mul(new Decimal(1).plus(s))
    : entry.mul(new Decimal(1).minus(s));
  return adjustPrice(raw.toFixed(8), symbolInfo);
}

/**
 * STOP_LIMIT prices for entry.
 * LONG (BUY STOP): stop = level; limit = level × (1 + offset%)
 * SHORT (SELL STOP): stop = level; limit = level × (1 - offset%)
 */
export function calcStopLimitPrices(
  levelPrice: string | Decimal,
  side: TradeSide,
  offsetPercent: string | number,
  symbolInfo: SymbolInfo,
): { stopPrice: string; limitPrice: string } {
  const level = new Decimal(levelPrice);
  const off = Decimal.max(new Decimal(0), new Decimal(offsetPercent)).div(100);
  const rawLimit = side === 'LONG'
    ? level.mul(new Decimal(1).plus(off))
    : level.mul(new Decimal(1).minus(off));
  return {
    stopPrice: adjustPrice(level.toFixed(8), symbolInfo),
    limitPrice: adjustPrice(rawLimit.toFixed(8), symbolInfo),
  };
}

export function sizeNearPriceLevel(params: {
  traderAllocation: string | Decimal;
  levelsPerSide: number;
  /** Geometric step from start (1 = nearest) — used for triangular scaling. */
  step: number;
  leverage: number;
  entryPrice: string;
  symbolInfo: SymbolInfo;
  capitalScalingEnabled: boolean;
}): { allocatedMargin: string; notional: string; quantity: string } {
  if (!params.capitalScalingEnabled) {
    const sized = sizeLevelPosition({
      traderAllocation: params.traderAllocation,
      level: 1,
      levelsPerSide: params.levelsPerSide,
      leverage: params.leverage,
      entryPrice: params.entryPrice,
      symbolInfo: params.symbolInfo,
      capitalScalingEnabled: false,
    });
    return {
      allocatedMargin: sized.allocatedMargin,
      notional: sized.notional,
      quantity: sized.quantity,
    };
  }
  const sideCap = new Decimal(params.traderAllocation).div(2);
  const sized = sizeLevelPosition({
    sideCapital: sideCap,
    level: params.step,
    levelsPerSide: params.levelsPerSide,
    leverage: params.leverage,
    entryPrice: params.entryPrice,
    symbolInfo: params.symbolInfo,
    capitalScalingEnabled: true,
  });
  return {
    allocatedMargin: sized.allocatedMargin,
    notional: sized.notional,
    quantity: sized.quantity,
  };
}

export { totalGridLevels, equalCapitalPerLevel, calcPositionNotional, calcQuantityFromNotional };
